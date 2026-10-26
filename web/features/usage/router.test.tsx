import { expect, test } from "bun:test";
import type { RouterReport } from "../../../server/features/usage/router.ts";
import { renderWith } from "../../test-render.tsx";
import { Router, trendOf } from "./router.tsx";

const week = (w: string, runs = 0) => ({
  week: w,
  runs,
  suggested: runs,
  accepted: runs / 2,
  notes: runs,
  delivered: runs,
  mod: 0,
});
const report = (over: Partial<RouterReport> = {}): RouterReport => ({
  runs: 40,
  agentRuns: 2,
  outcomes: { ok: 20, empty: 15, "bad-output": 0, error: 1, timeout: 3, superseded: 1 },
  latency: { p50: 5200, p90: 7900 },
  suggested: 30,
  accepted: 9,
  early: 2,
  notes: 20,
  delivered: 18,
  loads: 12,
  missed: 3,
  missedTop: [{ name: "prompt-design", count: 3 }],
  fixes: { runs: 4, total: 5 },
  cost: { usd: 0, runs: 0, input: 0, output: 0 },
  bySkill: [{ name: "dev-workflow", suggested: 10, accepted: 4 }],
  trend: [week("2026-09-28"), week("2026-10-05", 10), week("2026-10-12", 8)],
  unjoined: 1,
  unreadable: 0,
  errors: [],
  files: 3,
  ...over,
});

test("each figure answers its question, with its target and what it is for", async () => {
  const html = await renderWith(<Router r={report()} />, []);
  expect(html).toMatch(/30\s%/);
  expect(html).toContain("9 de 30 sugerencias");
  expect(html).toContain("2 ya las había cargado el modelo");
  expect(html).toContain("3 de 12 skills cargadas");
  expect(html).toContain("18 de 20 notas");
  expect(html).toContain("prompt-design");
  expect(html).toContain("4 de 10");
  expect(html).toContain("2 veces lo lanzó el modelo como subagente");
  // 30 % hit, 25 % missed and 90 % on time all sit between the goal and the alarm.
  expect(html.match(/vigilar/g)?.length).toBe(3);
  expect(html).toContain("objetivo ≥ 40 %");
  expect(html).toContain("Para qué: si baja, revisar la rúbrica");
  // Failures and latency belong to Salud, not here.
  expect(html).not.toMatch(/5,2\ss/);
});

test("under each week, the share of its prompts Log Pose read", async () => {
  const trend = [week("2026-10-05", 10), { ...week("2026-10-12", 8), mod: 6 }];
  const html = await renderWith(<Router r={report({ trend })} />, []);
  expect(html).toContain('aria-label="Motor de cada semana"');
  expect(html).toMatch(/title="[^"]*6 de 8 prompts con Log Pose"/);
  expect(html).toContain("0 de 10 prompts con Log Pose");
});

test("no runs says so; the trend starts at the router's first week", async () => {
  expect(await renderWith(<Router r={null} />, [])).toContain("no ha leído ningún prompt");
  expect(trendOf(report()).map((w) => w.week)).toEqual(["2026-10-05", "2026-10-12"]);
});
