import type { ServerWebSocket } from "bun";
import type { z } from "zod";
import type { ConsultationControl } from "../../../shared/coordination.ts";
import type {
  CreateEnvRequest,
  LaunchSpec,
  LaunchStatus,
  PasteMode,
  RunEnvRequest,
  ScreenText,
  TerminalRecord,
  WaitResult,
} from "../../../shared/host-contract.ts";
import type { Objective } from "../../../shared/objectives.ts";

// The wire half lives in shared/host-contract.ts; re-exported for the many callers here.
export {
  InputBody,
  type LaunchSpec,
  type LaunchStatus,
  MAX_INPUT,
  MAX_NAME,
  MAX_WAIT_MS,
  Message,
  NameBody,
  PasteMode,
  type ScreenText,
  TerminalRecord,
  TerminalState,
  WaitBody,
  type WaitResult,
} from "../../../shared/host-contract.ts";
export { KILL_AFTER_MS } from "../../launching.ts";
export { Listeners } from "../../listeners.ts";

// What both terminal engines share: the in-process TerminalManager (the PTY host runs it)
// and the server's HostClient. Nothing here loads xterm.

export const MAX_CLIENT_BUFFER = 4 * 1024 * 1024;

// "needs_you": it asked for a permission or finished its turn; either way it waits for the
// user. null: its harness records no state (Grok) or the record was not found. `asks`: it
// waits mid-turn on a permission or on a question, which only Claude records.
export type AgentState = "working" | "needs_you";
export type AgentAsk = "permission" | "question";
// `title` and `prompt`: what it works on, the session title and the last prompt its harness
// keeps in the transcript (Claude only). `lastMessage`: the start of the last thing it said
// (Claude, Codex); `question`: the text of the question it waits on (Claude).
export type AgentInfo = {
  sessionId: string | null;
  state: AgentState | null;
  asks?: AgentAsk;
  title?: string;
  prompt?: string;
  lastMessage?: string;
  question?: string;
};

export type TerminalKind = TerminalRecord["harness"];

// What «Reiniciar» answers: the terminal again, or why nothing was stopped.
export type RestartResult = { terminal: TerminalInfo } | { refused: "not_running" | "no_session" };

export const RESTART_REFUSAL_TEXT = {
  not_running: "esta terminal no está en marcha",
  no_session: "esta terminal todavía no tiene sesión que retomar",
} as const satisfies Record<Extract<RestartResult, { refused: string }>["refused"], string>;

// A terminal as the host reports it, plus what only the server adds: an agent's session and
// state as its harness records them (agents/state.ts); null for a shell, an env command or
// before it is known. `objective`: what it works on (objectives/store.ts); its `ticket` is then
// the effective one, not the launch ticket. `model`: a Claude terminal's launch model
// (terminals/models.ts); `local` is the PC's engine.
export type TerminalInfo = TerminalRecord & {
  agent?: AgentInfo | null;
  objective?: Objective | null;
  model?: string | null;
};

// What an engine needs from an attached window. The WebSocket routes adapt to it.
export interface Client {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  bufferedAmount(): number;
  isOpen(): boolean;
}

export type WaitOptions = { after?: number; quietMs?: number; timeoutMs?: number };

export const READ_LINES = 200;
export const MAX_READ_LINES = 2000;
export const QUIET_MS = 1500;
type Awaitable<T> = T | Promise<T>;

export interface Terminals {
  readonly consultations?: ConsultationControl;
  // The user's login environment, shared with the env provider's CLI.
  readonly env: Promise<Record<string, string>>;
  list(): Awaitable<TerminalInfo[]>;
  // Pids of the processes the app started directly (not their children).
  pids(): Awaitable<Set<number>>;
  get(id: string): Awaitable<TerminalInfo | undefined>;
  create(spec: LaunchSpec): Promise<TerminalInfo>;
  launchStatus?(id: string): Awaitable<LaunchStatus | null>;
  createEnv(req: CreateEnvRequest, size?: { cols?: number; rows?: number }): Promise<TerminalInfo>;
  runEnv(req: RunEnvRequest, size?: { cols?: number; rows?: number }): Promise<TerminalInfo>;
  // `take` displaces a window that holds the terminal; without it, that window keeps it and
  // the new one is told `busy` (4409).
  attach(id: string, client: Client, take?: boolean): Awaitable<boolean>;
  detach(id: string, client: Client): void;
  input(id: string, client: Client, data: string): void;
  resize(id: string, client: Client, cols: number, rows: number): void;
  // Agent access without attaching: the open window keeps its place.
  read(id: string, lines?: number): Awaitable<ScreenText | undefined>;
  write(id: string, data: string, opts?: { paste?: PasteMode }): Awaitable<boolean>;
  waitFor(id: string, opts: WaitOptions): Promise<WaitResult | undefined>;
  stop(id: string): Awaitable<boolean>;
  // Reopens a lost agent terminal with its own id; undefined when none is lost.
  resume(id: string): Promise<TerminalInfo | undefined>;
  // Stops a running agent and reopens it with its session and its id; undefined when there
  // is no such terminal, `refused` (nothing stopped) when it cannot come back.
  restart(id: string): Promise<RestartResult | undefined>;
  remove(id: string): Awaitable<boolean>;
  // Sets or clears the name; false when there is no such terminal.
  rename(id: string, name: string | null): Awaitable<boolean>;
  // Called whenever the list may have changed; returns the unsubscribe.
  subscribe(listener: () => void): () => void;
}

// A window with more live output buffered than this is dropped; reattaching gives it a
// fresh snapshot. The snapshot sits in the buffer too, so it does not count.
export function dropIfSlow(client: Client, snapshotBytes: number): boolean {
  if (client.bufferedAmount() <= MAX_CLIENT_BUFFER + snapshotBytes) return false;
  client.send(JSON.stringify({ type: "slow" }));
  client.close(4003, "slow client");
  return true;
}

export function socketClient(raw: ServerWebSocket): Client {
  return {
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
    isOpen: () => raw.readyState === 1,
    bufferedAmount: () => raw.getBufferedAmount(),
  };
}

export function parseMessage<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
