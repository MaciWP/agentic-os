import type { TerminalInfo } from "./queries.ts";

// A terminal for component tests; only what a test sets differs.
export const terminal = (over: Partial<TerminalInfo>): TerminalInfo => ({
  id: "t1",
  harness: "claude",
  location: "app",
  cwd: "/work/repo",
  ticket: null,
  name: null,
  env: null,
  action: null,
  state: "running",
  exitCode: null,
  signal: null,
  error: null,
  overflowed: false,
  attached: false,
  activity: "idle",
  lastOutputAt: null,
  pid: null,
  startedAt: "2026-10-01T08:00:00Z",
  endedAt: null,
  ...over,
});
