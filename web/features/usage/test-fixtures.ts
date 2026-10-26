import type { JudgeReport } from "../../../server/features/usage/judge.ts";
import type { LogPoseReport } from "../../../server/features/usage/logpose.ts";
import type { RouterReport } from "../../../server/features/usage/router.ts";
import type { LogPoseView } from "../../../server/features/usage/types.ts";

// A router period: the hook's four weeks before Log Pose, by default.
export const router = (over: Partial<RouterReport> = {}): RouterReport => ({
  runs: 100,
  agentRuns: 0,
  outcomes: { ok: 90, empty: 5, "bad-output": 0, error: 2, timeout: 3, superseded: 0 },
  latency: { p50: 5000, p90: 8000 },
  suggested: 50,
  accepted: 15,
  early: 0,
  notes: 40,
  delivered: 36,
  loads: 20,
  missed: 6,
  missedTop: [],
  fixes: { runs: 0, total: 0 },
  cost: { usd: 0.1, runs: 50, input: 0, output: 0 },
  bySkill: [],
  trend: [],
  unjoined: 0,
  unreadable: 0,
  errors: [],
  files: 1,
  ...over,
});

// A small week of the mod: 12 classified prompts.
export const pose = (over: Partial<LogPoseReport> = {}): LogPoseReport => ({
  since: "2026-10-15T22:34:00.000Z",
  prompts: 14,
  classified: 12,
  outcomes: { ok: 12 },
  latency: { p50: 1800, p90: 2500 },
  onTime: { notes: 12, delivered: 12 },
  levels: [
    { difficulty: "easy", effort: "low", count: 3 },
    { difficulty: "normal", effort: "medium", count: 6 },
    { difficulty: "hard", effort: "high", count: 3 },
    { difficulty: "", effort: "medium", count: 2 },
  ],
  floor: { level: "high", raised: 4, of: 12 },
  byLevel: [
    { effort: "high", turns: 10, stepsP50: 6, usd: 3, priced: 10, under: 0, over: 2 },
    { effort: "medium", turns: 4, stepsP50: 24, usd: 1, priced: 4, under: 3, over: 0 },
  ],
  leads: { underSteps: 20, overSteps: 2, overTools: 1 },
  overrides: [{ effort: "high", reason: "needs design" }],
  gauges: [
    { gauge: 0, turns: 8, ok: 7, under: 0, over: 1, advisorUsd: 0.4 },
    { gauge: 3, turns: 4, ok: 1, under: 3, over: 0, advisorUsd: 0.8 },
  ],
  cacheBreaks: 1,
  levelChanges: 5,
  steer: 0,
  dictation: {
    prompts: 2,
    total: 3,
    logged: 5,
    pairs: [{ heard: "biom", meant: "Biome", count: 2 }],
  },
  classify: { usd: 0.0312, runs: 12, unpriced: 0 },
  unreadable: 0,
  errors: [],
  ...over,
});

// No pass yet: nothing judged, the button on.
export const judge = (over: Partial<JudgeReport> = {}): JudgeReport => ({
  span: { from: "2026-10-16T18:00:00.000Z", to: "2026-10-22T10:00:00.000Z" },
  turns: 14,
  judged: 0,
  effort: { chosen: { under: 0, ok: 0, over: 0 }, applied: { under: 0, ok: 0, over: 0 } },
  byChosen: [],
  gauge: { under: 0, ok: 0, over: 0 },
  fixes: { ok: 0, wrong: 0, missed: 0, missedTop: [] },
  worst: [],
  last: null,
  running: false,
  available: true,
  auto: true,
  estimate: { turns: 14, usd: 0.0812 },
  ...over,
});

export const view = (
  over: Partial<LogPoseReport> = {},
  judged: Partial<JudgeReport> = {},
): LogPoseView => ({
  report: pose(over),
  mod: router({
    runs: 12,
    outcomes: { ok: 12, empty: 0, "bad-output": 0, error: 0, timeout: 0, superseded: 0 },
    latency: { p50: 1800, p90: 2500 },
    suggested: 10,
    accepted: 5,
    notes: 10,
    delivered: 10,
    loads: 5,
    missed: 2,
    cost: { usd: 0, runs: 0, input: 0, output: 0 },
  }),
  baseline: { ...router(), from: "2026-09-17T22:27:00.000Z", to: "2026-10-15T22:27:00.000Z" },
  efforts: {
    before: [
      { effort: "high", calls: 70 },
      { effort: "medium", calls: 25 },
      { effort: "xhigh", calls: 5 },
      { effort: "", calls: 9 },
    ],
    after: [
      { effort: "medium", calls: 90 },
      { effort: "high", calls: 10 },
    ],
  },
  judge: judge(judged),
});
