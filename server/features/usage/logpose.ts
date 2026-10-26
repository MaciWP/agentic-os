import type { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../../config.ts";
import { errorMessage } from "../../error-message.ts";
import { type Counts, costOf, LONG, type Price, priceOf } from "./pricing.ts";
import type { Cut } from "./report.ts";
import type { RouterRun } from "./router.ts";

// Is Poneglyph's Log Pose mod worth it? On Claude it replaces the router hook: one Sonnet call
// per typed prompt picks the skills, the turn's effort and an advisor gauge. It writes one file
// per session, `~/.cache/poneglyph/log-pose/<session>.jsonl`, appended at the end of each turn.
// The mod is early access, so every field but `at` and `ev` is optional.
// ponytail: read whole on every report, fine for tens of sessions a day; index by mtime past that.

const DIR = [".cache", "poneglyph", "log-pose"];
// The mod's cache guard: a step 0 whose level changed, within this long of the previous step.
const GAP_MS = 5 * 60_000;
const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
// A turn that may have needed more: low or medium with this many steps or more. One that may
// have needed less: high or more done in this few steps and tool calls. Leads for the weekly
// judge, not verdicts.
// ponytail: fixed cuts, tune them once the judge has a few weeks to compare against.
export const UNDER_STEPS = 20;
export const OVER_STEPS = 2;
export const OVER_TOOLS = 1;

const level = z.string().nullish();
const Fix = z.object({ heard: z.string(), meant: z.string() });
const Row = z.discriminatedUnion("ev", [
  z.object({ ev: z.literal("session"), at: z.number(), mode: z.string().optional() }),
  z.object({
    ev: z.literal("submit"),
    at: z.number(),
    call: z.boolean().default(false),
    outcome: z.string().optional(),
    ms: z.number().nonnegative().optional(),
    labels: z
      .object({ difficulty: z.string(), uncertainty: z.string(), continuity: z.string() })
      .partial()
      .nullish(),
    effort: level,
    // The session's own level, which the steps never go under.
    floor: level,
    gauge: z.number().int().nullish(),
    mode: z.string().optional(),
    // A prompt typed while a turn runs: the mod sets no level for it.
    mid: z.boolean().optional(),
    read: z.number().nonnegative().nullish(),
    // Dictation fixes, from mod 0.3.2 on; older rows have none.
    fixes: z.array(Fix).optional(),
  }),
  z.object({
    ev: z.literal("step"),
    at: z.number(),
    index: z.number().int(),
    effortIn: level,
    effortOut: level,
    tools: z.number().int().nonnegative().default(0),
    advisor: z.number().int().nonnegative().default(0),
    usage: z
      .object({ input: z.number(), read: z.number(), write: z.number(), output: z.number() })
      .nullish(),
  }),
  z.object({ ev: z.literal("override"), at: z.number(), effort: z.string(), reason: z.string() }),
  z.object({ ev: z.literal("complete"), at: z.number(), aborted: z.boolean().optional() }),
  // A turn the harness started on its own (a task notification): no prompt of the user's.
  z.object({ ev: z.literal("other"), at: z.number() }),
]);
type Row = z.infer<typeof Row>;
type Submit = Extract<Row, { ev: "submit" }>;

export type LogPoseFile = { sid: string; rows: Row[] };
export type LogPoseLogs = { files: LogPoseFile[]; unreadable: number; errors: string[] };

const missing = (err: unknown) => (err as { code?: string }).code === "ENOENT";

// Every session file. A file that cannot be read is an error to show; a line that does not
// parse is counted, never fatal.
export async function readLogPose(home: string): Promise<LogPoseLogs> {
  const dir = join(home, ...DIR);
  const out: LogPoseLogs = { files: [], unreadable: 0, errors: [] };
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch (err) {
    if (!missing(err)) out.errors.push(`${dir}: ${errorMessage(err)}`);
    return out;
  }
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(dir, name), "utf8");
    } catch (err) {
      if (!missing(err)) out.errors.push(`${name}: ${errorMessage(err)}`);
      continue;
    }
    const rows: Row[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        out.unreadable++;
        continue;
      }
      const r = Row.safeParse(json);
      // A row kind the mod adds later is not an error.
      if (r.success) rows.push(r.data);
      else if (!(json && typeof json === "object" && "ev" in json && "at" in json))
        out.unreadable++;
    }
    out.files.push({ sid: name.slice(0, -".jsonl".length), rows });
  }
  return out;
}

export type Fix = z.infer<typeof Fix>;

// One prompt of the user's and what followed it, up to the next prompt or harness turn.
export type Turn = {
  sid: string;
  // The submit row's time: the prompt, once classified.
  at: number;
  // The last row of the turn.
  end: number;
  // The next turn's start in the same session; null for the last one.
  next: number | null;
  call: boolean;
  outcome: string | null;
  mid: boolean;
  difficulty: string;
  // The level the mod chose, the floor over it, and the one step 0 ran at ("" none).
  chosen: string;
  floor: string;
  applied: string;
  gauge: number | null;
  steps: number;
  tools: number;
  advisor: number;
  aborted: boolean;
  // The model set a higher level with the mod's tool during the turn.
  raised: boolean;
  // Null before mod 0.3.2.
  fixes: Fix[] | null;
};

const higher = (a: string, b: string) => rank(a) < LEVELS.length && rank(a) > rank(b);

// The turns of one session file: each submit with the rows after it.
export function turnsOf(file: LogPoseFile): Turn[] {
  const out: Turn[] = [];
  let turn: Turn | null = null;
  for (const row of file.rows) {
    if (row.ev === "submit" || row.ev === "other") {
      if (turn) turn.next = row.at;
      turn =
        row.ev === "other"
          ? null
          : {
              sid: file.sid,
              at: row.at,
              end: row.at,
              next: null,
              call: row.call,
              outcome: row.call ? (row.outcome ?? null) : null,
              mid: row.mid ?? false,
              difficulty: row.labels?.difficulty ?? "",
              chosen: row.effort ?? "",
              floor: row.floor ?? "",
              applied: "",
              gauge: row.gauge ?? null,
              steps: 0,
              tools: 0,
              advisor: 0,
              aborted: false,
              raised: false,
              fixes: row.fixes ?? null,
            };
      if (turn) out.push(turn);
      continue;
    }
    if (!turn || row.ev === "session") continue;
    turn.end = row.at;
    if (row.ev === "step") {
      // `effortIn` is the level before the mod rewrote it; `effortOut`, the one sent.
      if (turn.steps === 0) turn.applied = row.effortOut ?? row.effortIn ?? "";
      turn.steps++;
      turn.tools += row.tools;
      turn.advisor += row.advisor;
    } else if (row.ev === "override") {
      if (higher(row.effort, turn.applied || turn.chosen)) turn.raised = true;
    } else if (row.ev === "complete") {
      turn.aborted = row.aborted ?? false;
    }
  }
  return out;
}

// Did the turn call the advisor as its gauge asked? 0: better not; 1: only if stuck or before
// a risky step; 2: once before done; 3: before the plan, when stuck and before done.
export function gaugeFit(gauge: number, calls: number): "ok" | "under" | "over" {
  if (gauge <= 0) return calls === 0 ? "ok" : "over";
  if (gauge === 1) return calls <= 1 ? "ok" : "over";
  if (gauge === 2) return calls === 0 ? "under" : calls <= 2 ? "ok" : "over";
  return calls >= 2 ? "ok" : "under";
}

// A main-session Claude call with its price: the turn's own work, or the advisor's.
export type PricedCall = { sid: string; at: number; role: "call" | "advisor"; usd: number | null };

export function pricedCalls(
  db: Database,
  pricing: Config["pricing"],
  from: string,
  to: string,
): PricedCall[] {
  return db
    .query<
      Counts & { session_id: string; at: string; role: string; model: string; long: number },
      [string, string]
    >(
      `SELECT session_id, at, role, model, ${LONG} AS long, input, cache_read, cache_write,
         cache_write_1h, output
       FROM agent_usage
       WHERE harness = 'claude' AND agent = '' AND role IN ('call', 'advisor') AND at >= ? AND at < ?
       ORDER BY at`,
    )
    .all(from, to)
    .map((r) => {
      const price = priceOf(pricing, r.model, Boolean(r.long));
      return {
        sid: r.session_id,
        at: Date.parse(r.at),
        role: r.role === "advisor" ? "advisor" : "call",
        usd: price ? costOf(price, r) : null,
      };
    });
}

export type LevelRow = {
  effort: string;
  turns: number;
  stepsP50: number | null;
  // The turns' own calls: `usd` over the `priced` turns.
  usd: number;
  priced: number;
  under: number;
  over: number;
};

export type GaugeRow = {
  gauge: number;
  turns: number;
  ok: number;
  under: number;
  over: number;
  advisorUsd: number;
};

export type LogPoseReport = {
  // The first row the mod ever wrote, ISO; null with no log at all.
  since: string | null;
  // Typed prompts in the period: classified by a call, or a continuation that kept the level.
  prompts: number;
  classified: number;
  outcomes: Record<string, number>;
  latency: { p50: number | null; p90: number | null };
  // The mod holds the prompt until it answers, so every answer is on time by construction:
  // `notes` counts the answers it owed (a prompt typed mid-turn with nothing to say owes none)
  // and a failure is counted in `outcomes`, not here.
  onTime: { notes: number; delivered: number };
  // The level each prompt ran at, by the task's difficulty ("" unlabelled).
  levels: { difficulty: string; effort: string; count: number }[];
  // The session's own level, set by the user: how many classified prompts it lifted.
  floor: { level: string | null; raised: number; of: number };
  // Turns by the level step 0 ran at: steps, cost, and the leads for too little or too much.
  byLevel: LevelRow[];
  // The rules behind `under` and `over`, for the page to say them.
  leads: { underSteps: number; overSteps: number; overTools: number };
  // Overrides the model sent with the mod's tool, `auto` left out, and why.
  overrides: { effort: string; reason: string }[];
  // Per advisor gauge, the turns that called it as asked, too little or too much.
  gauges: GaugeRow[];
  // Step 0 of a prompt whose level changed read less than 90 % of the previous prefix.
  cacheBreaks: number;
  levelChanges: number;
  steer: number;
  // Dictation: prompts with fixes and how many, from the router log; the pairs from the rows
  // that carry them (`logged` of the classified prompts).
  dictation: {
    prompts: number;
    total: number;
    logged: number;
    pairs: { heard: string; meant: string; count: number }[];
  };
  // The classifying calls' cost, from the router log's tokens at Sonnet's price: `runs` is how
  // many could be priced, `unpriced` the rest (no price, or no cache split).
  classify: { usd: number; runs: number; unpriced: number };
  unreadable: number;
  errors: string[];
};

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);
const rank = (effort: string) => {
  const i = (LEVELS as readonly string[]).indexOf(effort);
  return i < 0 ? LEVELS.length : i;
};
const HIGH = rank("high");
export const PAIRS_TOP = 8;

// A turn that may have needed a higher level, or a lower one.
export const underOf = (t: Turn) => t.raised || (rank(t.applied) < HIGH && t.steps >= UNDER_STEPS);
export const overOf = (t: Turn) =>
  !t.raised &&
  rank(t.applied) >= HIGH &&
  rank(t.applied) < LEVELS.length &&
  t.steps <= OVER_STEPS &&
  t.tools <= OVER_TOOLS;

// What the mod did in the period: the levels it set, the gauge against the advisor calls of
// each turn, the overrides and cache breaks, and what classifying cost. `runs` are the router
// log's `via=mod` lines, which carry the call's tokens; `sonnet` prices them. `calls` are the
// main sessions' priced calls, which give each turn its cost.
export function logPoseReport(
  logs: LogPoseLogs,
  runs: RouterRun[],
  sonnet: Price | null,
  cut: Cut,
  calls: PricedCall[] = [],
): LogPoseReport {
  const from = Date.parse(cut.from);
  const to = Date.parse(cut.to);
  const inCut = (at: number) => at >= from && at < to;
  const outcomes: Record<string, number> = {};
  const latencies: number[] = [];
  const levels = new Map<string, number>();
  const r: LogPoseReport = {
    since: null,
    prompts: 0,
    classified: 0,
    outcomes,
    latency: { p50: null, p90: null },
    onTime: { notes: 0, delivered: 0 },
    levels: [],
    floor: { level: null, raised: 0, of: 0 },
    byLevel: [],
    leads: { underSteps: UNDER_STEPS, overSteps: OVER_STEPS, overTools: OVER_TOOLS },
    overrides: [],
    gauges: [],
    cacheBreaks: 0,
    levelChanges: 0,
    steer: 0,
    dictation: { prompts: 0, total: 0, logged: 0, pairs: [] },
    classify: { usd: 0, runs: 0, unpriced: 0 },
    unreadable: logs.unreadable,
    errors: logs.errors,
  };
  let first = Number.POSITIVE_INFINITY;
  const floors = new Map<string, number>();
  const pairs = new Map<string, { heard: string; meant: string; count: number }>();
  const bySid = Map.groupBy(calls, (c) => c.sid);
  const byLevel = new Map<string, { row: LevelRow; steps: number[] }>();
  const gauges = new Map<number, GaugeRow>();
  for (const file of logs.files) {
    const rows = file.rows;
    if (rows[0]) first = Math.min(first, rows[0].at);
    let last: { effort: string; at: number; prefix: number } | null = null;
    for (const row of rows) {
      if (row.ev === "override") {
        if (inCut(row.at) && row.effort !== "auto")
          r.overrides.push({ effort: row.effort, reason: row.reason });
      } else if (row.ev === "step") {
        const effort = row.effortOut ?? row.effortIn ?? "";
        const u = row.usage;
        if (u && last && row.index === 0 && effort !== last.effort && row.at - last.at <= GAP_MS) {
          if (inCut(row.at)) {
            r.levelChanges++;
            if (last.prefix > 0 && u.read < 0.9 * last.prefix) r.cacheBreaks++;
          }
        }
        if (u) last = { effort, at: row.at, prefix: u.read + u.write + u.input };
      } else if (row.ev === "submit" && inCut(row.at)) {
        r.prompts++;
        if (row.mode === "steer") r.steer++;
        const key = `${row.labels?.difficulty ?? ""}\0${row.effort ?? ""}`;
        levels.set(key, (levels.get(key) ?? 0) + 1);
        if (!row.call) continue;
        r.classified++;
        const outcome = row.outcome ?? "unknown";
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        if (row.ms !== undefined && outcome !== "error" && outcome !== "timeout")
          latencies.push(row.ms);
        // A prompt typed mid-turn gets no level, so with nothing else to say it has no note. A
        // call that failed owes none either: it is a failure, counted in `outcomes`.
        if (outcome === "ok" || (outcome === "empty" && !row.mid)) {
          r.onTime.notes++;
          r.onTime.delivered++;
        }
        // Rows from before the mod logged its floor say nothing about it.
        if (row.effort && row.floor !== undefined) {
          r.floor.of++;
          if (row.floor) {
            floors.set(row.floor, (floors.get(row.floor) ?? 0) + 1);
            if (higher(row.floor, row.effort)) r.floor.raised++;
          }
        }
        if (row.fixes) {
          r.dictation.logged++;
          for (const f of row.fixes) {
            // The same mishearing in another case is one pair; a fix of case alone is real.
            const k = `${f.heard.toLowerCase()}\0${f.meant}`;
            const p = pairs.get(k) ?? { ...f, count: 0 };
            p.count++;
            pairs.set(k, p);
          }
        }
      }
    }
    const sidCalls = bySid.get(file.sid) ?? [];
    for (const t of turnsOf(file)) {
      if (!inCut(t.at) || t.steps === 0) continue;
      const stop = t.next ?? t.end + 60_000;
      const own = sidCalls.filter((c) => c.at >= t.at && c.at < stop);
      const work = own.filter((c) => c.role === "call");
      const level = byLevel.get(t.applied) ?? {
        row: { effort: t.applied, turns: 0, stepsP50: null, usd: 0, priced: 0, under: 0, over: 0 },
        steps: [],
      };
      level.row.turns++;
      level.steps.push(t.steps);
      if (work.length && work.every((c) => c.usd !== null)) {
        level.row.priced++;
        level.row.usd += work.reduce((n, c) => n + (c.usd ?? 0), 0);
      }
      if (underOf(t)) level.row.under++;
      if (overOf(t)) level.row.over++;
      byLevel.set(t.applied, level);
      if (t.call && t.gauge !== null) {
        const g = gauges.get(t.gauge) ?? {
          gauge: t.gauge,
          turns: 0,
          ok: 0,
          under: 0,
          over: 0,
          advisorUsd: 0,
        };
        g.turns++;
        g[gaugeFit(t.gauge, t.advisor)]++;
        for (const c of own) if (c.role === "advisor") g.advisorUsd += c.usd ?? 0;
        gauges.set(t.gauge, g);
      }
    }
  }
  r.since = Number.isFinite(first) ? new Date(first).toISOString() : null;
  latencies.sort((a, b) => a - b);
  r.latency = { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) };
  r.levels = [...levels]
    .map(([key, count]) => {
      const [difficulty = "", effort = ""] = key.split("\0");
      return { difficulty, effort, count };
    })
    .sort((a, b) => a.difficulty.localeCompare(b.difficulty) || rank(a.effort) - rank(b.effort));
  r.floor.level = [...floors].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  r.byLevel = [...byLevel.values()]
    .map(({ row, steps }) => ({
      ...row,
      stepsP50: percentile(
        steps.sort((a, b) => a - b),
        0.5,
      ),
    }))
    .sort((a, b) => rank(a.effort) - rank(b.effort));
  r.gauges = [...gauges.values()].sort((a, b) => a.gauge - b.gauge);
  r.dictation.pairs = [...pairs.values()]
    .sort((a, b) => b.count - a.count || a.heard.localeCompare(b.heard))
    .slice(0, PAIRS_TOP);
  for (const run of runs) {
    if (!inCut(run.at)) continue;
    if (run.fixes > 0) {
      r.dictation.prompts++;
      r.dictation.total += run.fixes;
    }
    const split =
      run.read !== null && run.write !== null ? { read: run.read, write: run.write } : null;
    const read = split?.read ?? readOf(logs, run);
    const usd =
      run.cost ??
      (sonnet && read !== null && run.input !== null
        ? classifyCost(sonnet, run, read, split?.write ?? null)
        : null);
    if (usd === null) r.classify.unpriced++;
    else {
      r.classify.runs++;
      r.classify.usd += usd;
    }
  }
  return r;
}

// The cache read of the submit row that logged this run, for router lines older than the
// mod's `read=`: same session, within a few seconds; null without one, since most of the
// prompt is a cached read and guessing would err fivefold.
function readOf(logs: LogPoseLogs, run: RouterRun): number | null {
  const file = logs.files.find((f) => f.sid === run.sid);
  const submit = file?.rows.find(
    (row): row is Submit => row.ev === "submit" && row.call && Math.abs(row.at - run.at) < 5_000,
  );
  return submit?.read ?? null;
}

// The router log gives input as read + written + new. With the written part logged, each is
// priced at its own rate; without it, all that was not read is priced as a cache write, the
// dearer of the two, so the figure errs high.
function classifyCost(price: Price, run: RouterRun, read: number, write: number | null): number {
  const total = run.input ?? 0;
  const cached = Math.min(read, total);
  const written = write === null ? total - cached : Math.min(write, total - cached);
  return costOf(price, {
    input: total - cached - written,
    cache_read: cached,
    cache_write: written,
    cache_write_1h: 0,
    output: run.output ?? 0,
  });
}

export type EffortCalls = { effort: string; calls: number }[];

// The main session's Claude calls per effort level in [from, to): what Log Pose sets. Subagents
// and the advisor run at levels of their own, so they stay out.
export function effortCalls(db: Database, from: string, to: string): EffortCalls {
  return db
    .query<{ effort: string; calls: number }, [string, string]>(
      `SELECT effort, count(*) AS calls FROM agent_usage
       WHERE harness = 'claude' AND role = 'call' AND agent = '' AND at >= ? AND at < ?
       GROUP BY effort ORDER BY calls DESC`,
    )
    .all(from, to);
}
