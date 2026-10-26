import type { Subprocess } from "bun";
import { killTree } from "../../run.ts";
import type { Activity } from "./activity.ts";
import type { Client, TerminalInfo } from "./contract.ts";
import type { Screen } from "./screen.ts";
import type { Splitter } from "./splitter.ts";

export type Live = {
  info: TerminalInfo;
  proc?: Subprocess;
  screen?: Screen;
  splitter: Splitter;
  // Resolves when the PTY reaches EOF: every byte the process wrote has been read.
  eof: Promise<void>;
  reachedEof: () => void;
  stopping: boolean;
  killTimer?: Timer;
  client?: Client;
  // The snapshot sits in the client's buffer too; only live output counts against the limit.
  snapshotBytes: number;
  // Woken on every output and on exit, for the agents waiting on this terminal.
  waiters: Set<() => void>;
  activity: Activity;
};

// What the list shows of a terminal: its stored info plus what changes without an event.
export function view(l: Live): TerminalInfo {
  const running = l.info.state === "running";
  const at = l.activity.lastOutputAt;
  return {
    ...l.info,
    attached: Boolean(l.client),
    activity: l.activity.tracked ? l.activity.state : null,
    lastOutputAt: at === null ? null : new Date(at).toISOString(),
    pid: running ? (l.proc?.pid ?? null) : null,
  };
}

export function wake(l: Live): void {
  for (const waiter of [...l.waiters]) waiter();
}

export function exitMessage(info: TerminalInfo) {
  return {
    type: "exit",
    state: info.state,
    code: info.exitCode,
    signal: info.signal,
    error: info.error,
  };
}

// Windows has neither signals nor groups: any signal ends the whole tree at once.
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 0) return;
  if (process.platform === "win32") {
    killTree(pid);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}
