import { z } from "zod";

export type Usage = {
  id: string;
  sessionId: string;
  cwd: string;
  branch: string;
  agent: string;
  skill: string;
  model: string;
  at: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  // A call the advisor tool made inside another call; absent for an ordinary call.
  role?: "advisor";
  // The effort level the call ran at ("high", ...), as Claude's line says; absent when unsaid.
  effort?: string;
};

type EventKind = "skill" | "command" | "subagent" | "tool" | "hook";
type AgentEvent = {
  id: string;
  kind: EventKind;
  sessionId: string;
  cwd: string;
  branch: string;
  agent: string;
  name: string;
  detail: string;
  ms: number | null;
  at: string;
};

// The cost a harness counted for a whole session, to check ours against.
export type CostCheck = {
  sessionId: string;
  startTime: string;
  totalUsd: number;
  models: Record<string, number>;
};

// What a reader gets from new lines: rows to write, usage ids that no longer hold, and the
// harness's own cost counts.
export type Parsed = { usage: Usage[]; events: AgentEvent[]; drop: string[]; checks: CostCheck[] };

const MAX_NAME = 120;

export const clip = (s: string) => s.slice(0, MAX_NAME);
export const n = z.number().int().nonnegative().catch(0);
