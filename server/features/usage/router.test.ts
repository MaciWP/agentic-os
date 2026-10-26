import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import {
  parseRouterLine,
  ROUTER_WINDOW_MS,
  readRouterLogs,
  routerLogFiles,
  routerReport,
} from "./router.ts";

const T = Date.parse("2026-10-14T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const line = (at: number, fields: string) => `${iso(at)} host=claude ${fields}`;
const CUT = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" };

function db() {
  const d = openDb(":memory:");
  d.query("INSERT INTO agent_places (id, cwd, branch) VALUES (1, '/r/app', '')").run();
  return d;
}
let n = 0;
const call = (d: ReturnType<typeof db>, harness: string, session: string, at: number) =>
  d
    .query(
      `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
         input, cache_read, cache_write, cache_write_1h, output)
       VALUES (?, ?, ?, 1, '', '', 'm', ?, 1, 0, 0, 0, 0)`,
    )
    .run(harness, `u${n++}`, session, iso(at));
const event = (
  d: ReturnType<typeof db>,
  session: string,
  kind: "skill" | "tool",
  name: string,
  at: number,
  agent = "",
) =>
  d
    .query(
      `INSERT INTO agent_events (harness, id, kind, session_id, place_id, agent, name, at)
       VALUES ('claude', ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(`e${n++}`, kind, session, agent, name, iso(at));

describe("router log lines", () => {
  test("a run with its cost, an old line without it, and the catch path's bare error", () => {
    expect(
      parseRouterLine(
        line(
          T,
          "session=a1b2c3d4 outcome=ok ms=5000 skills=flow,dev-workflow fixes=2 effort=high past=3 attended=1 entry=cli cost=0.012 in=9300 out=80 sid=a1b2c3d4-full",
        ),
      ),
    ).toEqual({
      at: T,
      host: "claude",
      agent: false,
      engine: "hook",
      session: "a1b2c3d4",
      sid: "a1b2c3d4-full",
      outcome: "ok",
      ms: 5000,
      skills: ["flow", "dev-workflow"],
      fixes: 2,
      cost: 0.012,
      input: 9300,
      output: 80,
      read: null,
      write: null,
    });
    const old = parseRouterLine(
      line(T, "session=a1b2c3d4 outcome=empty ms=3 skills=- fixes=0 past=1"),
    );
    expect([old?.skills, old?.cost, old?.sid]).toEqual([[], null, null]);
    const timeout = parseRouterLine(
      line(T, "session=a1b2c3d4 outcome=timeout ms=15000 cost=- in=- out=-"),
    );
    expect(timeout?.cost).toBeNull();
    expect(parseRouterLine(`${iso(T)} outcome=error ms=12`)?.session).toBeNull();
    expect(parseRouterLine(line(T, "via=agent session=a1b2c3d4 outcome=ok ms=1"))?.agent).toBe(
      true,
    );
    // Log Pose writes the same line with via=mod: its run, not a subagent's.
    const mod = parseRouterLine(
      line(
        T,
        "via=mod session=a1b2c3d4 outcome=ok ms=1700 cost=- read=8000 write=900 in=9000 out=60",
      ),
    );
    expect([mod?.engine, mod?.agent, mod?.cost, mod?.input, mod?.read, mod?.write]).toEqual([
      "mod",
      false,
      null,
      9000,
      8000,
      900,
    ]);
    // Not a router line: no time, or an outcome it never writes.
    expect(parseRouterLine("hello")).toBeNull();
    expect(parseRouterLine(line(T, "session=a1b2c3d4 outcome=maybe ms=1"))).toBeNull();
  });

  test("every project's log and the ones under ~/.claude/learned, each read once", async () => {
    const root = mkdtempSync(join(tmpdir(), "router-"));
    const project = join(root, "app");
    const home = join(root, "home");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, "sub"), { recursive: true });
    mkdirSync(join(project, ".claude", "learned"), { recursive: true });
    mkdirSync(join(home, ".claude", "learned", "-r-other"), { recursive: true });
    writeFileSync(join(home, ".claude", "learned", "instructions-loaded.log"), "");
    writeFileSync(
      join(project, ".claude", "learned", "prompt-router.log"),
      `${line(T, "session=a outcome=ok ms=1")}\nnot a line\n`,
    );
    writeFileSync(
      join(home, ".claude", "learned", "-r-other", "prompt-router.log"),
      `${line(T - 1, "session=b outcome=empty ms=1")}\n`,
    );
    const d = openDb(":memory:");
    // A subfolder and the root reach the same file through the git root.
    d.query("INSERT INTO agent_places (cwd, branch) VALUES (?, ''), (?, 'x')").run(
      join(project, "sub"),
      project,
    );
    const files = await routerLogFiles(d, home);
    expect(files.length).toBe(2);
    const logs = await readRouterLogs(files);
    expect([logs.runs.map((r) => r.session), logs.unreadable, logs.errors]).toEqual([
      ["b", "a"],
      1,
      [],
    ]);
  });

  test("a log that cannot be read is an error, not zero runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-"));
    const logs = await readRouterLogs([dir]);
    expect(logs.errors.length).toBe(1);
  });
});

describe("router report", () => {
  test("a suggestion counts when its session loads it before the next prompt", async () => {
    const d = db();
    const s = "aaaaaaaa-1111";
    call(d, "claude", s, T);
    // Run 1 suggests flow and pr-review: flow is loaded after the note, pr-review never.
    // A tool call after the note carries it.
    event(d, s, "tool", "Bash", T + 2_000);
    event(d, s, "skill", "flow", T + 3_000);
    // Run 2 suggests ui-design, which the model had loaded before the note came; then the
    // turn ends with no tool call. dataviz is loaded with no suggestion: a miss. A subagent's
    // load is not the session's.
    const t2 = T + 60_000;
    event(d, s, "skill", "ui-design", t2 - 2_000);
    event(d, s, "skill", "dataviz", t2 + 5_000);
    event(d, s, "skill", "natural-writing", t2 + 6_000, "Explore");
    // A reload of flow is not a miss.
    event(d, s, "skill", "flow", t2 + 7_000);
    const logs = await readLines([
      line(
        T + 1_000,
        "session=aaaaaaaa outcome=ok ms=1000 skills=flow,pr-review fixes=1 cost=0.01 in=100 out=10",
      ),
      line(
        t2,
        "session=aaaaaaaa outcome=ok ms=4000 skills=ui-design fixes=0 effort=high cost=0.02 in=200 out=20",
      ),
      line(t2 + 10 * 60_000, "session=aaaaaaaa outcome=timeout ms=15000"),
      line(T, "via=agent session=aaaaaaaa outcome=ok ms=1 skills=flow"),
    ]);
    const r = routerReport(d, logs, CUT);
    expect([r.runs, r.agentRuns, r.outcomes.ok, r.outcomes.timeout]).toEqual([3, 1, 2, 1]);
    expect([r.suggested, r.accepted, r.early]).toEqual([3, 2, 1]);
    expect([r.notes, r.delivered]).toEqual([2, 1]);
    expect([r.loads, r.missed, r.missedTop]).toEqual([3, 1, [{ name: "dataviz", count: 1 }]]);
    expect(r.fixes).toEqual({ runs: 1, total: 1 });
    expect(r.cost.usd).toBeCloseTo(0.03, 12);
    expect([r.cost.runs, r.cost.input, r.cost.output]).toEqual([2, 300, 30]);
    expect([r.latency.p50, r.latency.p90]).toEqual([1000, 4000]);
    expect(r.bySkill).toEqual([
      { name: "flow", suggested: 1, accepted: 1 },
      { name: "pr-review", suggested: 1, accepted: 0 },
      { name: "ui-design", suggested: 1, accepted: 1 },
    ]);
    const week = r.trend.at(-1);
    expect([r.trend.length, week?.week, week?.suggested, week?.accepted]).toEqual([
      8,
      "2026-10-12",
      3,
      2,
    ]);
  });

  test("the mod's note goes with step 0: delivered with no tool call after it", async () => {
    const d = db();
    call(d, "claude", "cccccccc-3333", T);
    const logs = await readLines([
      line(T + 1_000, "via=mod session=cccccccc outcome=ok ms=1700 skills=flow"),
      line(T + 60_000, "via=mod session=cccccccc outcome=timeout ms=8000"),
    ]);
    const r = routerReport(d, logs, CUT);
    expect([r.notes, r.delivered]).toEqual([1, 1]);
  });

  test("a load past the window is not an acceptance; a run outside the period is left out", async () => {
    const d = db();
    const s = "bbbbbbbb-2222";
    call(d, "claude", s, T);
    event(d, s, "skill", "flow", T + ROUTER_WINDOW_MS + 1_000);
    const logs = await readLines([
      line(T, "session=bbbbbbbb outcome=ok ms=0 skills=flow"),
      line(Date.parse(CUT.from) - 1, "session=bbbbbbbb outcome=ok ms=0 skills=flow"),
    ]);
    const r = routerReport(d, logs, CUT);
    expect([r.runs, r.suggested, r.accepted]).toEqual([1, 1, 0]);
  });

  test("two sessions sharing a prefix: the full id joins, else the one whose calls span the run", async () => {
    const d = db();
    // UUIDv7 ids a minute apart share their first 8 characters.
    const a = "01a0cd65-aaaa";
    const b = "01a0cd65-bbbb";
    call(d, "claude", a, T);
    call(d, "claude", b, T + 3 * 3_600_000);
    event(d, a, "skill", "flow", T + 1_000);
    event(d, b, "skill", "flow", T + 3 * 3_600_000 + 1_000);
    const logs = await readLines([
      line(T, "session=01a0cd65 outcome=ok ms=0 skills=flow"),
      line(T + 3 * 3_600_000, `session=01a0cd65 outcome=ok ms=0 skills=flow sid=${b}`),
      // Between both spans' reach: neither can be told apart.
      line(T + 90 * 60_000, "session=01a0cd65 outcome=ok ms=0 skills=flow"),
    ]);
    const r = routerReport(d, logs, CUT);
    expect([r.runs, r.suggested, r.accepted, r.unjoined]).toEqual([3, 2, 2, 1]);
  });
});

// Lines through the reader, as the route reads them.
async function readLines(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "router-"));
  const file = join(dir, "prompt-router.log");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return readRouterLogs([file]);
}
