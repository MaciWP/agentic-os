import { expect, test } from "bun:test";
import { modelUseOf, repricedOf } from "./models.tsx";
import type { UsageLine, UsageReport } from "./queries.ts";

const line = (key: string, cost: number | null, tokens = 100): UsageLine => ({
  key,
  calls: 1,
  tokens: { input: tokens, cacheRead: 0, cacheWrite: 0, output: 0 },
  cost,
  unpricedTokens: cost === null ? tokens : 0,
  longCalls: 0,
  saved: 0,
});

const report = {
  byModelRole: [
    line("lead|claude-opus-5-5", 3),
    line("advisor|claude-opus-5-5", 1),
    line("subagent|claude-haiku-5-5", 0.5),
    line("lead|gpt-x", null, 900),
  ],
  byModel: [line("claude-opus-5-5", 4), line("claude-haiku-5-5", 0.5), line("gpt-x", null)],
  repriced: {
    "claude-opus-5-5": { "claude-sonnet-5-5": 2.4 },
    "claude-haiku-5-5": { "claude-sonnet-5-5": 1.5 },
  },
} as unknown as UsageReport;

test("each model's amount splits by who spent it, largest first; no price is no money", () => {
  expect(modelUseOf(report, "money")).toEqual([
    { model: "claude-opus-5-5", total: 4, parts: { lead: 3, subagent: 0, advisor: 1 } },
    { model: "claude-haiku-5-5", total: 0.5, parts: { lead: 0, subagent: 0.5, advisor: 0 } },
  ]);
  expect(modelUseOf(report, "tokens").map((m) => [m.model, m.total])).toEqual([
    ["gpt-x", 900],
    ["claude-opus-5-5", 200],
    ["claude-haiku-5-5", 100],
  ]);
});

test("each priced model's cost next to the same tokens at another price", () => {
  expect(repricedOf(report, "claude-sonnet-5-5")).toEqual([
    { model: "claude-opus-5-5", actual: 4, as: 2.4 },
    { model: "claude-haiku-5-5", actual: 0.5, as: 1.5 },
  ]);
});
