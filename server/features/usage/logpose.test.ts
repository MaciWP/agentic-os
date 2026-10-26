import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import {
  effortCalls,
  gaugeFit,
  logPoseReport,
  type PricedCall,
  pricedCalls,
  readLogPose,
  UNDER_STEPS,
} from "./logpose.ts";
import { parseRouterLine } from "./router.ts";

const T = Date.parse("2026-10-16T10:00:00.000Z");
const CUT = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" };
const SONNET = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };

const submit = (at: number, over: Record<string, unknown> = {}) => ({
  at,
  ev: "submit",
  origin: "composer",
  call: true,
  outcome: "ok",
  ms: 1700,
  labels: { difficulty: "normal", uncertainty: "clear", continuity: "new" },
  skills: [],
  effort: "medium",
  gauge: 0,
  override: null,
  mode: "rewrite",
  read: 9000,
  ...over,
});
const step = (at: number, index: number, effort: string, read: number, advisor = 0) => ({
  at,
  ev: "step",
  turnId: `t${at}`,
  index,
  effortIn: "medium",
  effortOut: effort,
  stop: "end_turn",
  tools: 0,
  advisor,
  usage: { input: 2, read, write: 500, output: 100 },
});

async function home(files: Record<string, unknown[]>, raw = "") {
  const h = mkdtempSync(join(tmpdir(), "logpose-"));
  const dir = join(h, ".cache", "poneglyph", "log-pose");
  mkdirSync(dir, { recursive: true });
  for (const [sid, rows] of Object.entries(files))
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n${raw}`,
    );
  return h;
}

describe("log pose", () => {
  test("levels by difficulty, the gauge against the advisor, overrides and a cache break", async () => {
    const h = await home(
      {
        s1: [
          { at: T - 1, ev: "session", mode: "rewrite", prompt: "mod" },
          // Prompt 1: hard, high, gauge 2; the advisor is called in its second step.
          submit(T, {
            labels: { difficulty: "hard", uncertainty: "some-doubt", continuity: "new" },
            effort: "high",
            gauge: 2,
          }),
          step(T + 1_000, 0, "high", 100_000),
          step(T + 2_000, 1, "high", 100_500, 1),
          // Prompt 2: easy, low, gauge 0; level changed and the cache read collapsed: a break.
          submit(T + 60_000, {
            labels: { difficulty: "easy", uncertainty: "clear", continuity: "new" },
            effort: "low",
          }),
          step(T + 61_000, 0, "low", 1_000),
          // A continuation keeps the level with no call.
          { at: T + 90_000, ev: "submit", origin: "composer", call: false, effort: "low" },
          step(T + 91_000, 0, "low", 2_000),
          { at: T + 95_000, ev: "override", effort: "high", reason: "needs design" },
          { at: T + 96_000, ev: "override", effort: "auto", reason: "" },
          // A row kind the mod adds later is skipped without counting as unreadable.
          { at: T + 97_000, ev: "probe", x: 1 },
          // Outside the period.
          submit(Date.parse(CUT.to) + 1),
        ],
      },
      "not json\n",
    );
    const logs = await readLogPose(h);
    const run = parseRouterLine(
      `${new Date(T + 1_700).toISOString()} host=claude via=mod session=s1 outcome=ok ms=1700 cost=- in=10000 out=100 sid=s1`,
    );
    const r = logPoseReport(logs, run ? [run] : [], SONNET, CUT);
    expect([r.prompts, r.classified, r.outcomes.ok, r.latency.p50]).toEqual([3, 2, 2, 1700]);
    expect(r.levels).toEqual([
      { difficulty: "", effort: "low", count: 1 },
      { difficulty: "easy", effort: "low", count: 1 },
      { difficulty: "hard", effort: "high", count: 1 },
    ]);
    expect(r.gauges).toEqual([
      { gauge: 0, turns: 1, ok: 1, under: 0, over: 0, advisorUsd: 0 },
      { gauge: 2, turns: 1, ok: 1, under: 0, over: 0, advisorUsd: 0 },
    ]);
    expect(r.overrides).toEqual([{ effort: "high", reason: "needs design" }]);
    expect([r.levelChanges, r.cacheBreaks, r.steer]).toEqual([1, 1, 0]);
    // 9.000 read at 0,1, 1.000 written at 2,5 and 100 out at 10, per million.
    expect([r.classify.runs, r.classify.unpriced]).toEqual([1, 0]);
    expect(r.classify.usd).toBeCloseTo((9000 * 0.1 + 1000 * 2.5 + 100 * 10) / 1e6, 12);
    expect([r.since, r.unreadable, r.errors]).toEqual([new Date(T - 1).toISOString(), 1, []]);
  });

  test("turns: on time, the floor, leads by level, the gauge as asked, dictation pairs", async () => {
    const at = (n: number) => T + n * 1_000;
    // Every step came in at medium; the level it ran at is the one the mod sent out.
    const ran = (n: number, effort: string, tools = 0, advisor = 0) => ({
      ...step(at(n), 0, effort, 1_000, advisor),
      tools,
    });
    const jaicu = { heard: "jaicu", meant: "Haiku" };
    const h = await home({
      s2: [
        // Medium lifted to high by the floor; gauge 3 with one advisor call: too few.
        submit(at(0), { effort: "medium", floor: "high", gauge: 3, fixes: [jaicu] }),
        ran(1, "high", 3, 1),
        { ...ran(2, "high"), index: 1 },
        // Typed mid-turn with nothing to say: no note owed. Two quick steps at xhigh: a lead
        // for too much.
        submit(at(60), { effort: "high", floor: "high", outcome: "empty", mid: true, fixes: [] }),
        ran(61, "xhigh"),
        // Timed out: a failure, not a late note. Many steps at medium: a lead for too little.
        submit(at(120), {
          effort: "low",
          floor: "high",
          gauge: 1,
          outcome: "timeout",
          fixes: [jaicu],
        }),
        ...Array.from({ length: UNDER_STEPS + 1 }, (_, i) => ({
          ...ran(121 + i, "medium"),
          index: i,
        })),
        // A harness turn: its steps belong to no prompt.
        { at: at(200), ev: "other", origin: "task-notification" },
        ran(201, "low"),
        // The same mishearing in capitals; the floor field present but empty counts as a prompt
        // the floor did not lift. A row from before the mod logged it says nothing.
        submit(at(300), { floor: null, fixes: [{ heard: "JAICU", meant: "Haiku" }] }),
        submit(at(400)),
      ],
    });
    const run = parseRouterLine(
      `${new Date(at(1)).toISOString()} host=claude via=mod session=s2 outcome=ok ms=1700 fixes=1 cost=- read=8000 write=1000 in=10000 out=100 sid=s2`,
    );
    const calls: PricedCall[] = [
      { sid: "s2", at: at(1.5), role: "call", usd: 0.5 },
      { sid: "s2", at: at(1.6), role: "advisor", usd: 0.2 },
      { sid: "s2", at: at(61), role: "call", usd: 0.1 },
      { sid: "s2", at: at(130), role: "call", usd: null },
    ];
    const r = logPoseReport(await readLogPose(h), run ? [run] : [], SONNET, CUT, calls);
    expect(r.onTime).toEqual({ notes: 3, delivered: 3 });
    expect(r.floor).toEqual({ level: "high", raised: 2, of: 4 });
    expect(r.byLevel).toEqual([
      {
        effort: "medium",
        turns: 1,
        stepsP50: UNDER_STEPS + 1,
        usd: 0,
        priced: 0,
        under: 1,
        over: 0,
      },
      { effort: "high", turns: 1, stepsP50: 2, usd: 0.5, priced: 1, under: 0, over: 0 },
      { effort: "xhigh", turns: 1, stepsP50: 1, usd: 0.1, priced: 1, under: 0, over: 1 },
    ]);
    expect(r.gauges).toEqual([
      { gauge: 0, turns: 1, ok: 1, under: 0, over: 0, advisorUsd: 0 },
      { gauge: 1, turns: 1, ok: 1, under: 0, over: 0, advisorUsd: 0 },
      { gauge: 3, turns: 1, ok: 0, under: 1, over: 0, advisorUsd: 0.2 },
    ]);
    expect(r.dictation).toEqual({
      prompts: 1,
      total: 1,
      logged: 4,
      pairs: [{ ...jaicu, count: 3 }],
    });
    // With the cache split logged: 1.000 new at 2, 8.000 read at 0,1, 1.000 written at 2,5 and
    // 100 out at 10, per million.
    expect(r.classify.usd).toBeCloseTo((1000 * 2 + 8000 * 0.1 + 1000 * 2.5 + 100 * 10) / 1e6, 12);
  });

  test("the gauge as its note words it", () => {
    const fit = (gauge: number) => [0, 1, 2, 3].map((calls) => gaugeFit(gauge, calls));
    expect(fit(0)).toEqual(["ok", "over", "over", "over"]);
    expect(fit(1)).toEqual(["ok", "ok", "over", "over"]);
    expect(fit(2)).toEqual(["under", "ok", "ok", "over"]);
    expect(fit(3)).toEqual(["under", "under", "ok", "ok"]);
  });

  test("no log folder is no data, not an error; an unreadable file is an error", async () => {
    const none = await readLogPose(mkdtempSync(join(tmpdir(), "logpose-")));
    expect([none.files, none.errors]).toEqual([[], []]);
    const h = await home({});
    mkdirSync(join(h, ".cache", "poneglyph", "log-pose", "bad.jsonl"));
    expect((await readLogPose(h)).errors.length).toBe(1);
  });

  test("effort calls: the main session's Claude calls only, inside the window", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO agent_places (id, cwd, branch) VALUES (1, '/r', '')").run();
    let n = 0;
    const add = (harness: string, agent: string, role: string, effort: string, at: string) =>
      db
        .query(
          `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
             input, cache_read, cache_write, cache_write_1h, output, role, effort)
           VALUES (?, ?, 's', 1, ?, '', 'm', ?, 1, 0, 0, 0, 0, ?, ?)`,
        )
        .run(harness, `u${n++}`, agent, at, role, effort);
    add("claude", "", "call", "high", "2026-10-13T10:00:00.000Z");
    add("claude", "", "call", "high", "2026-10-14T10:00:00.000Z");
    add("claude", "", "call", "medium", "2026-10-14T11:00:00.000Z");
    add("claude", "Explore", "call", "low", "2026-10-14T12:00:00.000Z");
    add("claude", "", "advisor", "", "2026-10-14T12:00:00.000Z");
    add("codex", "", "call", "high", "2026-10-14T12:00:00.000Z");
    add("claude", "", "call", "low", "2026-10-20T12:00:00.000Z");
    expect(effortCalls(db, CUT.from, CUT.to)).toEqual([
      { effort: "high", calls: 2 },
      { effort: "medium", calls: 1 },
    ]);
    // The main session's calls and the advisor's, priced; subagents and other harnesses out.
    const priced = pricedCalls(
      db,
      { m: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 } },
      CUT.from,
      CUT.to,
    );
    expect(priced.map((c) => [c.role, c.usd])).toEqual([
      ["call", 1],
      ["call", 1],
      ["call", 1],
      ["advisor", 1],
    ]);
    expect(pricedCalls(db, {}, CUT.from, CUT.to)[0]?.usd).toBeNull();
  });
});
