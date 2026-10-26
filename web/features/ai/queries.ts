import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiState } from "../../../server/features/ai/engine.ts";
import { machinePath } from "../../../shared/machines.ts";
import { mutate, unwrap } from "../../api.ts";
import { currentMachine, machineUrl } from "../../machine.ts";
import { pollEvery } from "../../poll.ts";

export type { AiState };

type AiStatus = ({ configured: true } & AiState) | { configured: false; machine: string | null };

// The local model's engine as this tab reaches it: `base` is where its routes are (this
// machine's, or on the hub the worker that runs it), `machine` that worker. null: none.
export type Ai = { base: string; machine: string | null; state: AiState };

const AI_POLL_MS = 3000;

async function read(url: string): Promise<AiStatus> {
  return unwrap(await fetch(url, { cache: "no-store" })) as Promise<AiStatus>;
}

export async function readAi(get: (url: string) => Promise<AiStatus> = read): Promise<Ai | null> {
  const here = await get(machineUrl("/api/ai"));
  if (here.configured) return { base: "/api/ai", machine: currentMachine || null, state: here };
  // Only the hub names the worker; a worker tab reaches it directly.
  if (!here.machine || currentMachine) return null;
  const base = machinePath("/api/ai", here.machine);
  const there = await get(base);
  return there.configured ? { base, machine: here.machine, state: there } : null;
}

// Polled while the projects tree or the system panel is mounted, to follow a start or the idle
// stop. A worker that is down, or no engine at all, is asked ten times less often.
export const useAi = () =>
  useQuery({
    queryKey: ["ai"],
    queryFn: () => readAi(),
    retry: false,
    refetchInterval: (q) =>
      q.state.data === null ? AI_POLL_MS * 10 : pollEvery(AI_POLL_MS, 10)(q),
  });

export type AiAction = { start: true } | { stop: true } | { gameMode: boolean };

export function useAiAction(base: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (a: AiAction) =>
      "start" in a
        ? mutate<AiState>(`${base}/start`, "POST")
        : "stop" in a
          ? mutate<AiState>(`${base}/stop`, "POST")
          : mutate<AiState>(`${base}/game-mode`, "POST", { on: a.gameMode }),
    onSuccess: (state) =>
      client.setQueryData<Ai | null>(["ai"], (ai) => (ai ? { ...ai, state } : ai)),
  });
}
