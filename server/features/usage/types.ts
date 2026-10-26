import type { JudgeReport } from "./judge.ts";
import type { EffortCalls, LogPoseReport } from "./logpose.ts";
import type { RouterReport } from "./router.ts";
export type UsageTokens = { input: number; cacheRead: number; cacheWrite: number; output: number };
// One row of a breakdown. `cost` adds up the priced models only (null: none priced);
// `unpricedTokens` is what is left out of it.
export type UsageLine = {
  key: string;
  calls: number;
  tokens: UsageTokens;
  cost: number | null;
  unpricedTokens: number;
  // Calls whose prompt (input and cache) was over LONG_PROMPT tokens.
  longCalls: number;
  // What the cache reads saved against the input price, for the priced models (null: none).
  saved: number | null;
};
export type UsageSession = UsageLine & {
  harness: string;
  sessionId: string;
  ticket: string | null;
  location: string;
  cwd: string;
  branch: string;
  // The app terminal's name, when the session ran in one.
  terminal: string | null;
  models: string[];
  first: string;
  last: string;
};
export type EventCount = { name: string; detail: string; count: number };
export type HookLine = {
  name: string;
  ok: number;
  block: number;
  error: number;
  timeout: number;
  avgMs: number | null;
  maxMs: number | null;
  // The time every run of the hook added up to.
  totalMs: number;
};
// Each day of the range, oldest first: money for the priced models and every token.
export type DailySeries = { cost: number[]; tokens: number[] };
// One ticket's work in the range, from every call and session, not only the costliest.
export type TicketUsage = {
  models: UsageLine[];
  skills: UsageLine[];
  subagents: UsageLine[];
  harnesses: UsageLine[];
  // The most expensive TICKET_SESSIONS; `sessionCount` counts them all.
  sessions: UsageSession[];
  sessionCount: number;
  first: string | null;
  last: string | null;
  // Hours with at least one session open, overlaps counted once.
  activeHours: number;
  daily: DailySeries;
};
export type UsageReport = {
  from: string;
  to: string;
  // The first day with a call, whatever the range.
  firstDay: string | null;
  days: string[];
  total: UsageLine;
  byTicket: UsageLine[];
  byLocation: UsageLine[];
  byModel: UsageLine[];
  // Tokens Claude attributes to each skill while it is active.
  bySkill: UsageLine[];
  bySubagent: UsageLine[];
  // Who spent it: the main agent ("lead"), its subagents ("subagent") and the advisor tool.
  byRole: UsageLine[];
  // The same, model by model: the key is "<role>|<model>".
  byModelRole: UsageLine[];
  // Claude's calls, the advisor's left out, by the effort level they ran at ("" unsaid).
  byEffort: UsageLine[];
  // Sessions that called the advisor.
  advisorSessions: number;
  // Sessions with Claude calls: the only harness with an advisor.
  claudeSessions: number;
  // Each priced Claude model's tokens at every configured price, by pricing key.
  repriced: Record<string, Record<string, number>>;
  bySession: UsageSession[];
  events: {
    skills: EventCount[];
    commands: EventCount[];
    subagents: EventCount[];
    tools: EventCount[];
    mcp: EventCount[];
    hooks: HookLine[];
  };
  // By ticket key or goal:<id>, "" for the work with no objective and "*" for all of it.
  tickets: Record<string, TicketUsage>;
  // The title of each goal:<id> key in the range.
  goals: Record<string, string>;
  // The same number of days just before, or null for the whole history.
  previous: { from: string; to: string; total: UsageLine; byTicket: UsageLine[] } | null;
  // Models with tokens and no price in the config.
  unpriced: string[];
  ingest: { lastRunAt: string | null; ms: number | null; files: number; errors: string[] };
  // How Poneglyph's prompt router did in the period; null outside a quota week or month.
  router: RouterReport | null;
  // Log Pose, the mod that replaced the router hook on Claude: what it did in the period, its
  // router figures there, and the hook's in the four weeks before it ran; null before it ran
  // or outside a quota week or month.
  logPose: LogPoseView | null;
};

// One hour of a period, for one harness, model, objective ("" for none) and project. `h` counts
// hours from the period's start; `cost` is null for a model with no price.
export type PeriodRow = {
  h: number;
  harness: string;
  model: string;
  ticket: string;
  project: string;
  cost: number | null;
  tokens: number;
};
// One hour of the weeks before an open period, `h` from the first of them: harness and
// ticket or not are what the page filters on.
export type HistoryRow = {
  h: number;
  harness: string;
  ticketed: boolean;
  cost: number | null;
  tokens: number;
};
export type QuotaSample = {
  harness: string;
  minutes: number;
  at: string;
  percent: number | null;
  resetAt: string | null;
};
// Our cost of the period's Claude sessions against what Claude Code counted for them, on this
// Mac. Sessions whose count started late (ours over it by 10 %) are left out and counted apart.
export type Coverage = {
  sessions: number;
  harnessUsd: number;
  oursUsd: number;
  // What Claude Code counted and the transcripts do not hold, session by session.
  outsideUsd: number;
  late: number;
};
// A quota week or a calendar month. `offset` counts periods back from the current one.
export type UsagePeriod = {
  kind: "week" | "month";
  offset: number;
  // Where the week's bounds come from: the plan's reset, a saved sample of it, or Monday.
  anchor: "plan" | "sample" | "monday" | "month";
  start: string;
  end: string;
  now: string;
  hours: number;
  // Hours gone by: all of them for a closed period.
  elapsed: number;
  rows: PeriodRow[];
  previous: { start: string; end: string; hours: number; rows: PeriodRow[] };
  quota: QuotaSample[];
  // The quota weeks before the current one, for its projection; null for a closed period.
  history: { start: string; weeks: number; rows: HistoryRow[] } | null;
  coverage: Coverage | null;
  goals: Record<string, string>;
  unpriced: string[];
};

export type LogPoseView = {
  report: LogPoseReport;
  mod: RouterReport;
  baseline: RouterReport & { from: string; to: string };
  // The main session's calls per effort level, before the mod and in the period.
  efforts: { before: EffortCalls; after: EffortCalls };
  // The weekly judge's verdicts on the period's turns, and its last pass.
  judge: JudgeReport;
};
