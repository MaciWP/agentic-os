import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import type { TerminalInfo, TerminalKind } from "../../../server/features/terminals/contract.ts";
import type { Harness } from "../../../server/features/terminals/harness.ts";
import type { EnvAction } from "../../../shared/envs.ts";
import { type Effort, LOCAL_MODEL } from "../../../shared/harness-capabilities.ts";
import { ApiError, api, mutate, unwrap } from "../../api.ts";
import { storageFamily } from "../../storage.ts";
import { createStore } from "../../store.ts";
import { errorText } from "../../ui.tsx";
import { mesaSearch, readMesas } from "./mesas.ts";
import { useMesa } from "./place.ts";

export type { EnvAction, Harness, TerminalInfo };

export const HARNESSES: Harness[] = ["shell", "claude", "codex", "grok"];

export const HARNESS_LABEL: Record<TerminalKind, string> = {
  shell: "Shell",
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  env: "Entorno",
};

// What an env command is called wherever it shows: its button on an env, and its terminal.
export const ENV_ACTION_LABEL: Record<EnvAction | "create", string> = {
  create: "Crear entorno",
  start: "Arrancar",
  stop: "Parar",
  update: "Actualizar",
  remove: "Borrar entorno",
  logs: "Logs",
  doctor: "Diagnóstico",
};

// What runs in it: an env command's terminal goes by its command; the others by their harness.
// A Claude terminal whose model runs on the PC's engine (server/features/ai).
export const LOCAL_LABEL = "Claude local";

export const kindLabel = (t: TerminalInfo) =>
  t.harness === "env" && t.action
    ? ENV_ACTION_LABEL[t.action]
    : t.model === LOCAL_MODEL
      ? LOCAL_LABEL
      : HARNESS_LABEL[t.harness];

// The user's name for it when there is one, which tells two shells of one repo apart.
export const terminalLabel = (t: TerminalInfo) => t.name ?? kindLabel(t);

// The last two folders of a path: enough to tell two checkouts apart.
export const shortPath = (path: string) =>
  path.split("/").filter(Boolean).slice(-2).join("/") || path;

export function useTerminals() {
  return useQuery({
    queryKey: ["terminals"],
    queryFn: async () => unwrap(await api.api.terminals.$get()),
    // Read again when the server says the list changed (web/events.ts), never polled.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// What the agent starts on: the server builds the prompt from these ids, never from text.
export type LaunchFor = {
  ticket?: string;
  review?: { repo: string; number: number };
  savedPrompt?: string;
  // A model id and an effort the CLI gets as flags; none keeps the CLI's own default.
  model?: string;
  effort?: Effort;
};

// A launch not yet confirmed, per tab, under the button's own key: a retry reuses its id.
export const pendingLaunches = storageFamily("aos.launch:", {
  schema: z.string(),
  fallback: "",
  area: "session",
});
// The same ids in memory, for when the browser cannot keep them.
const launchIds = createStore<Readonly<Record<string, string>>>({});
// Tells LaunchRecovery to read the pending launches again (no window in unit tests).
const announce = () => globalThis.window?.dispatchEvent(new Event("aos:launch-pending"));
export function forgetLaunch(key: string) {
  launchIds.update(({ [key]: _, ...rest }) => rest);
  pendingLaunches.remove(key);
  announce();
}
export async function createTerminal(
  harness: Harness,
  location: string,
  launchFor: LaunchFor = {},
) {
  const key = JSON.stringify({ harness, location, ...launchFor });
  const requestId = launchIds.get()[key] || pendingLaunches.get(key) || crypto.randomUUID();
  launchIds.update((ids) => ({ ...ids, [key]: requestId }));
  pendingLaunches.set(key, requestId);
  try {
    const result = await mutate<{ terminal: TerminalInfo }>("/api/terminals", "POST", {
      harness,
      location,
      ...launchFor,
      requestId,
    });
    forgetLaunch(key);
    return result;
  } catch (error) {
    // A refusal started nothing, so the next click is a new request. Anything else may have
    // launched: the id stays for the same retry.
    if (error instanceof ApiError && error.code === "launch_rejected") forgetLaunch(key);
    else announce();
    throw error;
  }
}

export const createEnv = (name: string, repos: string[], branch: string) =>
  mutate<{ terminal: TerminalInfo }>("/api/envs", "POST", { name, repos, branch });

// One of the env provider's commands, in a visible terminal. `name` for the ones that act on
// one env; `confirm` is the env's name, typed for remove.
export const runEnv = (action: EnvAction, name?: string, confirm?: string) =>
  mutate<{ terminal: TerminalInfo }>("/api/envs/run", "POST", {
    action,
    ...(name && { name }),
    ...(confirm !== undefined && { confirm }),
  });

// Not polled: listing shells out to the env provider's CLI.
export function useEnvs() {
  return useQuery({
    queryKey: ["envs"],
    queryFn: async () => unwrap(await api.api.envs.$get()),
    staleTime: 30_000,
  });
}

export const attachToken = (id: string) =>
  mutate<{ token: string }>(`/api/terminals/${encodeURIComponent(id)}/attach`, "POST");

export function useTerminalAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "stop" | "restart" | "remove" }) =>
      action === "remove"
        ? mutate(`/api/terminals/${encodeURIComponent(id)}`, "DELETE")
        : mutate(`/api/terminals/${encodeURIComponent(id)}/${action}`, "POST"),
    onSettled: () => client.invalidateQueries({ queryKey: ["terminals"] }),
  });
}

// Reopens a terminal the PTY host lost, with its own id, so this window attaches again.
export function useResumeTerminal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      mutate<{ terminal: TerminalInfo }>(`/api/terminals/${encodeURIComponent(id)}/resume`, "POST"),
    onSettled: () => client.invalidateQueries({ queryKey: ["terminals"] }),
  });
}

// Sets the terminal's name; an empty one clears it.
export function useRenameTerminal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      mutate<{ name: string | null }>(`/api/terminals/${encodeURIComponent(id)}/name`, "POST", {
        name,
      }),
    onSettled: () => client.invalidateQueries({ queryKey: ["terminals"] }),
  });
}

// Opens the terminal's folder in the editor the profile names; the server picks the path.
export function useOpenFolder() {
  return useMutation({
    mutationFn: (id: string) =>
      mutate<{ opened: true }>(`/api/terminals/${encodeURIComponent(id)}/open-folder`, "POST"),
  });
}

const POPUP = "popup,width=1040,height=700";

// Reuses the window already showing this terminal, if there is one.
export const openTerminalWindow = (id: string) =>
  window.open(`/terminal/${encodeURIComponent(id)}`, `aos-terminal-${id}`, POPUP);

// The node of the projects tree a terminal shows under: an env command runs in the envs root
// and belongs to the env it acts on.
export const nodeKey = (t: TerminalInfo) =>
  t.harness === "env" && t.env ? `env:${t.env}` : t.location;

// Starts a terminal and shows it as a tile in the Mesa, from any page, or hands it to
// `onStarted` instead. One launch at a time per form.
export function useLaunch(onStarted?: (terminal: TerminalInfo) => void) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const mesa = useMesa();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function launch(start: () => Promise<{ terminal: TerminalInfo }>) {
    if (pending) return;
    setPending(true);
    setError(null);
    const origin = mesa?.id ?? readMesas().activeId;
    try {
      const { terminal } = await start();
      if (onStarted) onStarted(terminal);
      else if (mesa) mesa.open(terminal);
      else
        void navigate({ to: "/terminales", search: mesaSearch({ mesa: origin, t: terminal.id }) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
      await client.invalidateQueries({ queryKey: ["terminals"] });
    }
  }
  return { launch, pending, error };
}
