import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { Services } from "../../deps.ts";
import { ObjectiveStore } from "../objectives/store.ts";
import type { PlanUsage } from "../system/plan-usage.ts";
import { claudeLines } from "./claude.ts";
import { UsageIngest } from "./ingest.ts";
import { coverageOf, nextReset, periodBounds, usagePeriod } from "./period.ts";
import { samplePlans } from "./plan-samples.ts";
import { usageRoutes } from "./routes.ts";

const config = ConfigSchema.parse({
  jira: { site: "https://x.atlassian.net", project: "ABC" },
  // $1 per million input tokens: a call's input is its cost in micro-dollars.
  pricing: { "claude-opus-5-5": { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
});

const costState = (startTime: number, total: number, models: Record<string, number>) =>
  JSON.stringify({
    type: "cost-state",
    sessionId: "s-1",
    startTime,
    totalCostUSD: total,
    totalAPIDuration: 1,
    modelUsage: Object.fromEntries(
      Object.entries(models).map(([m, usd]) => [
        m,
        { inputTokens: 1, outputTokens: 1, costUSD: usd },
      ]),
    ),
  });

type Call = { session: string; at: string; input: number; branch?: string; model?: string };
function seed(calls: Call[]) {
  const db = openDb(":memory:");
  calls.forEach((c, i) => {
    const branch = c.branch ?? "";
    db.query("INSERT OR IGNORE INTO agent_places (cwd, branch) VALUES ('/r/app', ?)").run(branch);
    const place = db
      .query<{ id: number }, [string]>("SELECT id FROM agent_places WHERE branch = ?")
      .get(branch)?.id;
    db.query(
      `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
         input, cache_read, cache_write, cache_write_1h, output)
       VALUES ('claude', ?, ?, ?, '', '', ?, ?, ?, 0, 0, 0, 0)`,
    ).run(`m${i}`, c.session, place ?? 0, c.model ?? "claude-opus-5-5", c.at, c.input);
  });
  return db;
}
const check = (db: ReturnType<typeof openDb>, session: string, usd: number, models = "{}") =>
  db
    .query(
      `INSERT INTO agent_cost_checks (harness, session_id, start_time, total_usd, models)
       VALUES ('claude', ?, '2026-10-10T00:00:00.000Z', ?, ?)`,
    )
    .run(session, usd, models);

describe("Claude Code's own cost count", () => {
  test("the reader keeps each cost-state line, and none from a subagent's file", () => {
    const lines = [
      costState(Date.parse("2026-10-10T08:00:00Z"), 1.5, { "claude-opus-5-5[1m]": 1.5 }),
      JSON.stringify({ type: "cost-state", totalCostUSD: "x" }),
    ];
    const out = claudeLines(lines, { sessionId: "s-1", agent: "" }, { cwd: "", branch: "" });
    expect(out.checks).toEqual([
      {
        sessionId: "s-1",
        startTime: "2026-10-10T08:00:00.000Z",
        totalUsd: 1.5,
        models: { "claude-opus-5-5[1m]": 1.5 },
      },
    ]);
    const sub = claudeLines(lines, { sessionId: "s-1", agent: "Explore" }, { cwd: "", branch: "" });
    expect(sub.checks).toEqual([]);
  });

  test("the ingest keeps the last count of a session, across reads", async () => {
    const home = mkdtempSync(join(tmpdir(), "aos-usage-"));
    try {
      const dir = join(home, ".claude", "projects", "-w");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "s-1.jsonl");
      const t = Date.parse("2026-10-10T08:00:00Z");
      writeFileSync(file, `${costState(t, 1, {})}\n${costState(t, 2, {})}\n`);
      const db = openDb(":memory:");
      const ingest = new UsageIngest({ db, home, grokUsage: null });
      await ingest.run();
      const total = () =>
        db.query<{ total_usd: number }, []>("SELECT total_usd FROM agent_cost_checks").all();
      expect(total()).toEqual([{ total_usd: 2 }]);
      writeFileSync(
        file,
        `${costState(t, 1, {})}\n${costState(t, 2, {})}\n${costState(t, 3, {})}\n`,
      );
      await ingest.run();
      expect(total()).toEqual([{ total_usd: 3 }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("coverage adds what each session misses and never lets one over cancel it", () => {
    const at = "2026-10-10T10:00:00.000Z";
    const db = seed([
      // Ours $0.9 of $1: $0.1 outside the transcript.
      { session: "a", at, input: 900_000 },
      // Ours $2 of $1: Claude Code started counting late; left out.
      { session: "b", at, input: 2_000_000 },
      // Ours $1 of $1.
      { session: "c", at, input: 1_000_000 },
      // Under the floor, with a free model, or started before the period: none counts.
      { session: "d", at, input: 100_000 },
      { session: "e", at, input: 100_000 },
      { session: "f", at: "2026-10-01T10:00:00.000Z", input: 1_000_000 },
    ]);
    check(db, "a", 1);
    check(db, "b", 1);
    check(db, "c", 1);
    check(db, "d", 0.2);
    check(db, "e", 1, JSON.stringify({ local: 0.5, "claude-opus-5-5": 0.5 }));
    check(db, "f", 1);
    const b = { start: new Date("2026-10-09T18:00:00Z"), end: new Date("2026-10-16T18:00:00Z") };
    const c = coverageOf(db, config, b);
    expect(c?.sessions).toBe(2);
    expect(c?.late).toBe(1);
    expect(c?.harnessUsd).toBeCloseTo(2);
    expect(c?.oursUsd).toBeCloseTo(1.9);
    expect(c?.outsideUsd).toBeCloseTo(0.1);
    expect(coverageOf(seed([]), config, b)).toBeNull();
  });
});

describe("usage by quota week and month", () => {
  let tz: string | undefined;
  beforeEach(() => {
    // bun test runs in UTC; restore the zone it had, never undefined.
    tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "Europe/Madrid";
  });
  afterEach(() => {
    process.env.TZ = tz;
  });

  const now = new Date("2026-10-14T12:00:00Z");
  const plan = (at: string) => ({ at, from: "plan" as const });

  test("the week ends at the next reset, even from a reading older than it", () => {
    const reset = Date.parse("2026-10-16T18:00:00Z");
    expect(nextReset(reset, now.getTime())).toBe(reset);
    // Read two weeks before: the same hour, two weeks on.
    expect(nextReset(Date.parse("2026-10-02T18:00:00Z"), now.getTime())).toBe(reset);
    // Exactly at the reset, the next week has begun.
    expect(nextReset(reset, reset)).toBe(reset + 7 * 86_400_000);
    const b = periodBounds({ kind: "week", offset: 1 }, now, plan("2026-10-02T18:00:00Z"));
    expect([b.start.toISOString(), b.end.toISOString(), b.anchor]).toEqual([
      "2026-10-02T18:00:00.000Z",
      "2026-10-09T18:00:00.000Z",
      "plan",
    ]);
  });

  test("without a plan reading the week is Monday to Monday, and a month is the calendar one", () => {
    const w = periodBounds({ kind: "week", offset: 0 }, now, null);
    // Madrid is UTC+2 in October.
    expect([w.start.toISOString(), w.end.toISOString(), w.anchor]).toEqual([
      "2026-10-11T22:00:00.000Z",
      "2026-10-18T22:00:00.000Z",
      "monday",
    ]);
    const m = periodBounds({ kind: "month", offset: 1 }, now, null);
    expect([m.start.toISOString(), m.end.toISOString()]).toEqual([
      "2026-08-31T22:00:00.000Z",
      "2026-09-30T22:00:00.000Z",
    ]);
  });

  test("rows count hours from the start, a reset at :30 cuts its hour, and the week before comes along", () => {
    const db = seed([
      // Before the reset at 18:30: the week before.
      { session: "a", at: "2026-10-09T18:10:00.000Z", input: 1_000_000 },
      { session: "a", at: "2026-10-09T18:40:00.000Z", input: 2_000_000, branch: "feature/ABC-7" },
      { session: "a", at: "2026-10-09T20:35:00.000Z", input: 3_000_000 },
      { session: "a", at: "2026-10-09T20:50:00.000Z", input: 1_000_000, model: "gpt-x" },
    ]);
    const p = usagePeriod(
      db,
      config,
      { kind: "week", offset: 0 },
      { weeklyResetAt: "2026-10-16T18:30:00.000Z", now },
    );
    expect([p.start, p.end, p.hours, p.elapsed]).toEqual([
      "2026-10-09T18:30:00.000Z",
      "2026-10-16T18:30:00.000Z",
      168,
      114,
    ]);
    const rows = p.rows.map((r) => [r.h, r.ticket, r.project, r.model, r.cost]).sort();
    expect(rows).toEqual([
      [0, "ABC-7", "app", "claude-opus-5-5", 2],
      [2, "", "app", "claude-opus-5-5", 3],
      [2, "", "app", "gpt-x", null],
    ]);
    expect(p.previous.rows.map((r) => [r.h, r.cost])).toEqual([[167, 1]]);
    expect(p.unpriced).toEqual(["gpt-x"]);
    expect(p.coverage).toBeNull();
  });

  test("the current week brings the four quota weeks before it, by hour, harness and ticket", () => {
    const db = seed([
      // Before the four weeks: out.
      { session: "a", at: "2026-09-11T18:00:00.000Z", input: 9_000_000 },
      // Three weeks into them, in one hour: two calls with no ticket add up, one with a ticket apart.
      { session: "a", at: "2026-10-02T19:10:00.000Z", input: 1_000_000 },
      { session: "a", at: "2026-10-02T19:20:00.000Z", input: 2_000_000 },
      { session: "b", at: "2026-10-02T19:25:00.000Z", input: 4_000_000, branch: "feature/ABC-7" },
      // The current week: out.
      { session: "a", at: "2026-10-10T10:00:00.000Z", input: 8_000_000 },
    ]);
    const plan = { weeklyResetAt: "2026-10-16T18:30:00.000Z", now };
    const p = usagePeriod(db, config, { kind: "week", offset: 0 }, plan);
    expect([p.history?.start, p.history?.weeks]).toEqual(["2026-09-11T18:30:00.000Z", 4]);
    const rows = p.history?.rows.map((r) => [r.h, r.harness, r.ticketed, r.cost, r.tokens]).sort();
    expect(rows).toEqual([
      [504, "claude", false, 3, 3_000_000],
      [504, "claude", true, 4, 4_000_000],
    ]);
    // A past week projects nothing, so it carries no history.
    expect(usagePeriod(db, config, { kind: "week", offset: 1 }, plan).history).toBeNull();
  });

  test("a saved sample anchors the week when the plan cannot be read", () => {
    const db = seed([]);
    db.query(
      `INSERT INTO plan_samples (harness, window_minutes, at, percent, reset_at)
       VALUES ('claude', 10080, '2026-10-13T00:00:00.000Z', 40, '2026-10-16T18:00:00.000Z')`,
    ).run();
    const p = usagePeriod(db, config, { kind: "week", offset: 0 }, { weeklyResetAt: null, now });
    expect([p.anchor, p.start]).toEqual(["sample", "2026-10-09T18:00:00.000Z"]);
    expect(p.quota).toEqual([
      {
        harness: "claude",
        minutes: 10080,
        at: "2026-10-13T00:00:00.000Z",
        percent: 40,
        resetAt: "2026-10-16T18:00:00.000Z",
      },
    ]);
  });

  test("the route checks its query and reads the plan for the week", async () => {
    const db = seed([{ session: "a", at: "2026-10-10T10:00:00.000Z", input: 1 }]);
    const ingest = new UsageIngest({ db, home: "/nonexistent", grokUsage: null });
    const reading: PlanUsage = {
      windows: [{ minutes: 10_080, percent: 50, resetAt: "2026-10-16T18:00:00.000Z" }],
      updatedAt: "2026-10-14T00:00:00.000Z",
    };
    const app = usageRoutes(
      { config, db, objectives: new ObjectiveStore(db) } as Services,
      ingest,
      undefined,
      async () => reading,
    );
    expect((await app.request("/period?kind=year")).status).toBe(400);
    expect((await app.request("/period?kind=week&offset=-1")).status).toBe(400);
    const res = await app.request("/period?kind=week");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { anchor: string; end: string };
    expect(body.anchor).toBe("plan");
    expect(Date.parse(body.end) > Date.now()).toBe(true);
  });
});

test("the report route reads the period the chart shows, cut to its instants", async () => {
  const now = Date.now();
  const start = now - 5 * 86_400_000;
  const db = seed([
    // Hours before the week starts, maybe on its first local day: the week before.
    { session: "a", at: new Date(start - 3_600_000).toISOString(), input: 1 },
    { session: "a", at: new Date(now - 3_600_000).toISOString(), input: 1 },
  ]);
  const ingest = new UsageIngest({ db, home: "/nonexistent", grokUsage: null });
  const reading: PlanUsage = {
    windows: [
      { minutes: 10_080, percent: 50, resetAt: new Date(start + 7 * 86_400_000).toISOString() },
    ],
    updatedAt: new Date(now).toISOString(),
  };
  const app = usageRoutes(
    { config, db, objectives: new ObjectiveStore(db) } as Services,
    ingest,
    undefined,
    async () => reading,
    mkdtempSync(join(tmpdir(), "home-")),
  );
  expect((await app.request("/?kind=day")).status).toBe(400);
  const res = await app.request("/?kind=week");
  expect(res.status).toBe(200);
  const r = (await res.json()) as {
    total: { calls: number };
    previous: { total: { calls: number } };
    router: { runs: number; files: number } | null;
  };
  expect([r.total.calls, r.previous.total.calls]).toEqual([1, 1]);
  // The router's runs come with a period, none here.
  expect(r.router).toMatchObject({ runs: 0, files: 0 });
});

describe("plan samples", () => {
  test("a window is written only when its percent or reset changed", async () => {
    const db = openDb(":memory:");
    let percent = 10;
    let updatedAt = "2026-10-14T10:00:00.000Z";
    const claude = async (): Promise<PlanUsage> => ({
      windows: [
        { minutes: 300, percent: 3, resetAt: "2026-10-14T15:00:00.000Z" },
        { minutes: 10_080, percent, resetAt: "2026-10-16T18:00:00.000Z" },
      ],
      updatedAt,
    });
    const codex = async (): Promise<PlanUsage> => ({ error: "no_source" });
    expect(await samplePlans(db, { claude, codex })).toBe(2);
    updatedAt = "2026-10-14T10:05:00.000Z";
    expect(await samplePlans(db, { claude, codex })).toBe(0);
    percent = 11;
    expect(await samplePlans(db, { claude, codex })).toBe(1);
    const rows = db
      .query<{ percent: number }, []>(
        "SELECT percent FROM plan_samples WHERE window_minutes = 10080 ORDER BY at",
      )
      .all();
    expect(rows.map((r) => r.percent)).toEqual([10, 11]);
  });

  test("a reader that throws costs the other harness nothing", async () => {
    const db = openDb(":memory:");
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    const claude = async (): Promise<PlanUsage> => {
      throw new Error("hud file locked");
    };
    const codex = async (): Promise<PlanUsage> => ({
      windows: [{ minutes: 300, percent: 5, resetAt: "2026-10-14T15:00:00.000Z" }],
      updatedAt: "2026-10-14T10:00:00.000Z",
    });
    expect(await samplePlans(db, { claude, codex })).toBe(1);
    expect(String(quiet.mock.calls[0]?.[0])).toContain("plan sample: claude");
    quiet.mockRestore();
  });
});
