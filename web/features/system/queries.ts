import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LimitWindow, PlanUsage } from "../../../server/features/system/plan-usage.ts";
import type { Plans, SystemSnapshot } from "../../../server/features/system/system.ts";
import { api, mutate, unwrap } from "../../api.ts";
import { machineUrl } from "../../machine.ts";
import { pollEvery } from "../../poll.ts";

export type { LimitWindow, Plans, PlanUsage, SystemSnapshot };

export const SYSTEM_POLL_MS = 5000;

// What the app costs and the subscription's use, for the top bar. Paused while the tab is
// hidden (refetchIntervalInBackground stays off).
export const systemOptions = {
  queryKey: ["system"],
  queryFn: async (): Promise<SystemSnapshot> => unwrap(await api.api.system.$get()),
  refetchInterval: pollEvery(SYSTEM_POLL_MS),
};

export const useSystem = () => useQuery(systemOptions);

// The screen kept on for 1, 2 or 4 hours or with no limit (null); `false` frees it.
export type ScreenChoice = 60 | 120 | 240 | null | false;

export function useHoldScreen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (choice: ScreenChoice) =>
      mutate<{ awake: SystemSnapshot["awake"] }>("/api/system/awake", "POST", {
        screen: choice === false ? null : { minutes: choice },
      }),
    onSuccess: ({ awake }) =>
      client.setQueryData<SystemSnapshot>(["system"], (s) => (s ? { ...s, awake } : s)),
  });
}

// "Reiniciar": the server alone (terminals keep running) or with the PTY host.
export type RestartScope = "server" | "all";

export const RESTART_WAIT_MS = 90_000;

export const askRestart = (scope: RestartScope) =>
  mutate<{ restarting: RestartScope; pid: number }>("/api/system/restart", "POST", { scope });

// True once a server other than `pid` answers; false when none does in time. While it is down
// the fetch fails (or the remote ingress answers 502): that is the wait, not an error.
export async function newServerUp(
  pid: number,
  {
    get = (url: string, init: RequestInit) => fetch(url, init),
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    url = machineUrl("/api/health"),
  }: {
    // Another machine's health, when the page waits on a worker it does not show.
    url?: string;
    get?: (url: string, init: RequestInit) => Promise<Response>;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {},
  timeoutMs = RESTART_WAIT_MS,
): Promise<boolean> {
  const end = now() + timeoutMs;
  while (now() < end) {
    await sleep(1000);
    try {
      const res = await get(url, { cache: "no-store" });
      const body = res.ok ? ((await res.json()) as { pid?: unknown }) : null;
      if (typeof body?.pid === "number" && body.pid !== pid) return true;
    } catch {}
  }
  return false;
}
