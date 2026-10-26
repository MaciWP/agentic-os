import type { Database } from "bun:sqlite";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dayOf, daysBefore, weekOf } from "../../../shared/days.ts";
import { errorMessage } from "../../error-message.ts";
import { gitRoot } from "./place-of.ts";
import type { Cut } from "./report.ts";

// Does Poneglyph's prompt router work? Its hook (poneglyph `hooks/prompt-router.ts`), and on
// Claude the Log Pose mod that replaced it (`via=mod`), write one line per prompt to `<project>/.claude/learned/prompt-router.log`, or under
// `~/.claude/learned/<project>/` when the project does not ignore that folder. The logs are
// read whole on each report: they never rotate and hold a few hundred lines a week.
// ponytail: read on every report, move to a table read by offset when they pass a few MB.

const LOG = "prompt-router.log";
// A suggestion counts when the session loads it within this long of the run's start, before
// the next prompt's run.
export const ROUTER_WINDOW_MS = 30 * 60_000;
export const TREND_WEEKS = 8;

const OUTCOMES = ["ok", "empty", "bad-output", "error", "timeout", "superseded"] as const;
type Outcome = (typeof OUTCOMES)[number];
const count = z.coerce.number().int().nonnegative();
// "-" is a run that said nothing: a timeout, a newer prompt, or a line older than the field.
const dashed = z
  .union([z.literal("-"), z.coerce.number().nonnegative()])
  .optional()
  .transform((v) => (typeof v === "number" ? v : null));
const RouterLine = z.object({
  at: z.iso.datetime(),
  host: z.enum(["claude", "codex", "grok"]).default("claude"),
  // "agent": the subagent the main model launched, whose spend is in the transcripts already;
  // "mod": Log Pose, the mod that replaces the hook on Claude.
  via: z.string().optional(),
  // The catch path logs neither: an error with no session to join.
  session: z
    .string()
    .regex(/^[\w-]{1,8}$/)
    .optional(),
  sid: z
    .string()
    .regex(/^[\w-]+$/)
    .optional(),
  outcome: z.enum(OUTCOMES),
  ms: count,
  skills: z.string().default("-"),
  fixes: count.default(0),
  cost: dashed,
  in: dashed,
  out: dashed,
  // Log Pose's split of `in`: the cached prefix read and written.
  read: dashed,
  write: dashed,
});

export type RouterRun = {
  at: number;
  host: "claude" | "codex" | "grok";
  agent: boolean;
  engine: "hook" | "mod";
  session: string | null;
  sid: string | null;
  outcome: Outcome;
  ms: number;
  skills: string[];
  fixes: number;
  cost: number | null;
  input: number | null;
  output: number | null;
  read: number | null;
  write: number | null;
};

// One log line, or null when it is not one the router writes.
export function parseRouterLine(line: string): RouterRun | null {
  const [at, ...pairs] = line.trim().split(" ");
  const fields: Record<string, string> = { at: at ?? "" };
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i > 0) fields[p.slice(0, i)] = p.slice(i + 1);
  }
  const r = RouterLine.safeParse(fields);
  if (!r.success) return null;
  const v = r.data;
  return {
    at: Date.parse(v.at),
    host: v.host,
    agent: v.via === "agent",
    engine: v.via === "mod" ? "mod" : "hook",
    session: v.session ?? null,
    sid: v.sid && v.sid !== "-" ? v.sid : null,
    outcome: v.outcome,
    ms: v.ms,
    skills: v.skills === "-" ? [] : v.skills.split(",").filter(Boolean),
    fixes: v.fixes,
    cost: v.cost,
    input: v.in,
    output: v.out,
    read: v.read,
    write: v.write,
  };
}

// No such file, or a part of its path is a file: nothing to read there.
const missing = (err: unknown) => {
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

// The router's logs: one per project a harness worked in, under the project or under
// `~/.claude/learned/`; the same file reached twice is read once.
export async function routerLogFiles(db: Database, home: string): Promise<string[]> {
  const cwds = db.query<{ cwd: string }, []>("SELECT DISTINCT cwd FROM agent_places").all();
  const roots = new Set(cwds.flatMap(({ cwd }) => [cwd, gitRoot(cwd)]));
  const candidates = [...roots].map((root) => join(root, ".claude", "learned", LOG));
  const learned = join(home, ".claude", "learned");
  try {
    for (const dir of await readdir(learned, { withFileTypes: true }))
      if (dir.isDirectory()) candidates.push(join(learned, dir.name, LOG));
  } catch (err) {
    if (!missing(err)) throw err;
  }
  const out = new Set<string>();
  for (const file of candidates) {
    try {
      out.add(await realpath(file));
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }
  return [...out].sort();
}

export type RouterLogs = { runs: RouterRun[]; unreadable: number; errors: string[]; files: number };

// Every run in those files. A file that cannot be read is an error to show, never zero runs.
export async function readRouterLogs(files: string[]): Promise<RouterLogs> {
  const runs: RouterRun[] = [];
  const errors: string[] = [];
  let unreadable = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (!missing(err)) errors.push(`${file}: ${errorMessage(err)}`);
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const run = parseRouterLine(line);
      if (run) runs.push(run);
      else unreadable++;
    }
  }
  return { runs: runs.sort((a, b) => a.at - b.at), unreadable, errors, files: files.length };
}

export type RouterWeek = {
  week: string;
  runs: number;
  suggested: number;
  accepted: number;
  notes: number;
  delivered: number;
  // Runs of the Log Pose mod among them.
  mod: number;
};

export type RouterReport = {
  // Runs of the hook in the period; the subagent's apart.
  runs: number;
  agentRuns: number;
  outcomes: Record<Outcome, number>;
  latency: { p50: number | null; p90: number | null };
  // Skills suggested in runs joined to their session, and how many the session loaded after.
  suggested: number;
  accepted: number;
  // Loaded before the run ended: the right skill, which the model found on its own.
  early: number;
  // Runs that left a note, and how many a tool call of their turn picked up.
  notes: number;
  delivered: number;
  // Skills the session loaded in a turn the router read: suggested or not.
  loads: number;
  missed: number;
  missedTop: { name: string; count: number }[];
  fixes: { runs: number; total: number };
  cost: { usd: number; runs: number; input: number; output: number };
  bySkill: { name: string; suggested: number; accepted: number }[];
  trend: RouterWeek[];
  // Runs whose session could not be told apart or was never read.
  unjoined: number;
  unreadable: number;
  errors: string[];
  files: number;
};

type Session = { skills: { at: number; name: string }[]; tools: number[] };
type Span = { id: string; harness: string; first: number; last: number };

// The session a run belongs to: its full id, or the one with its prefix whose calls span the
// run. Codex and Grok ids are UUIDv7, so a minute apart they share the first 8 characters.
function sessionResolver(db: Database) {
  const spans = new Map<string, Span[]>();
  const rows = db
    .query<{ harness: string; id: string; first: string; last: string }, []>(
      `SELECT harness, session_id AS id, min(at) AS first, max(at) AS last
       FROM agent_usage GROUP BY harness, session_id`,
    )
    .all();
  for (const r of rows) {
    const key = `${r.harness}\0${r.id.slice(0, 8)}`;
    const list = spans.get(key) ?? [];
    list.push({ ...r, first: Date.parse(r.first), last: Date.parse(r.last) });
    spans.set(key, list);
  }
  return (run: RouterRun): string | null => {
    if (run.sid) return run.sid;
    if (!run.session) return null;
    const list = spans.get(`${run.host}\0${run.session}`) ?? [];
    if (list.length === 1) return list[0]?.id ?? null;
    const near = list.filter(
      (s) => s.first - ROUTER_WINDOW_MS <= run.at && run.at <= s.last + ROUTER_WINDOW_MS,
    );
    return near.length === 1 ? (near[0]?.id ?? null) : null;
  };
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

const emptyWeek = (week: string): RouterWeek => ({
  week,
  runs: 0,
  suggested: 0,
  accepted: 0,
  notes: 0,
  delivered: 0,
  mod: 0,
});

// The period's runs measured against what their sessions did after them, and the weeks up to
// the period's end for the trend.
export function routerReport(db: Database, logs: RouterLogs, cut: Cut): RouterReport {
  const from = Date.parse(cut.from);
  const to = Date.parse(cut.to);
  const weeks = Array.from({ length: TREND_WEEKS }, (_, i) =>
    weekOf(daysBefore(new Date(to - 1), 7 * (TREND_WEEKS - 1 - i))),
  );
  const trendFrom = new Date(`${weeks[0]}T00:00:00`).getTime();
  const since = Math.min(from, trendFrom);
  const resolve = sessionResolver(db);

  // The lead's skill loads, all of them (a reload is not a miss), and its tool calls in range.
  const sessions = new Map<string, Session>();
  const events = db
    .query<{ id: string; at: string; kind: string; name: string }, [string, string]>(
      `SELECT session_id AS id, at, kind, name FROM agent_events
       WHERE agent = '' AND (kind = 'skill' OR (kind = 'tool' AND at >= ? AND at < ?))
       ORDER BY at`,
    )
    .all(
      new Date(since - ROUTER_WINDOW_MS).toISOString(),
      new Date(to + ROUTER_WINDOW_MS).toISOString(),
    );
  for (const e of events) {
    let s = sessions.get(e.id);
    if (!s) {
      s = { skills: [], tools: [] };
      sessions.set(e.id, s);
    }
    if (e.kind === "skill") s.skills.push({ at: Date.parse(e.at), name: e.name });
    else s.tools.push(Date.parse(e.at));
  }

  // Each hook run's turn: from its start to the next run of its session, at most the window.
  type Turn = { run: RouterRun; id: string | null; start: number; end: number; next: number };
  const hook = logs.runs.filter((r) => !r.agent);
  const turns: Turn[] = hook.map((run) => ({
    run,
    id: resolve(run),
    start: run.at - run.ms,
    end: run.at - run.ms + ROUTER_WINDOW_MS,
    next: Number.POSITIVE_INFINITY,
  }));
  const bySession = new Map<string, Turn[]>();
  for (const t of turns) {
    if (!t.id) continue;
    const list = bySession.get(t.id) ?? [];
    list.push(t);
    bySession.set(t.id, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.start - b.start);
    list.forEach((t, i) => {
      const n = list[i + 1];
      if (n) {
        t.next = n.start;
        t.end = Math.min(t.end, n.start);
      }
    });
  }

  const inCut = (at: number) => at >= from && at < to;
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const skillRows = new Map<string, { suggested: number; accepted: number }>();
  const trend = new Map(weeks.map((w) => [w, emptyWeek(w)]));
  const latencies: number[] = [];
  const r: RouterReport = {
    runs: 0,
    agentRuns: logs.runs.filter((x) => x.agent && inCut(x.at)).length,
    outcomes,
    latency: { p50: null, p90: null },
    suggested: 0,
    accepted: 0,
    early: 0,
    notes: 0,
    delivered: 0,
    loads: 0,
    missed: 0,
    missedTop: [],
    fixes: { runs: 0, total: 0 },
    cost: { usd: 0, runs: 0, input: 0, output: 0 },
    bySkill: [],
    trend: [],
    unjoined: 0,
    unreadable: logs.unreadable,
    errors: logs.errors,
    files: logs.files,
  };

  for (const t of turns) {
    const { run } = t;
    const now = inCut(run.at);
    const week = run.at < to ? trend.get(weekOf(dayOf(new Date(run.at)))) : undefined;
    if (!now && !week) continue;
    const s = t.id ? sessions.get(t.id) : undefined;
    let suggested = 0;
    let accepted = 0;
    let early = 0;
    for (const name of run.skills) {
      suggested++;
      const load = s?.skills.find((l) => l.name === name && l.at >= t.start && l.at < t.end);
      if (load) {
        accepted++;
        if (load.at < run.at) early++;
      }
      if (now && t.id) {
        const row = skillRows.get(name) ?? { suggested: 0, accepted: 0 };
        row.suggested++;
        if (load) row.accepted++;
        skillRows.set(name, row);
      }
    }
    // A tool call after the note sends a new request, which carries it; none, and the turn
    // ended before the note arrived. The mod blocks the prompt until it answers, so its note
    // always goes with step 0.
    const note = run.outcome === "ok";
    const delivered =
      note &&
      (run.engine === "mod" ||
        !!s?.tools.some((at) => at > run.at && at < Math.min(t.next, run.at + ROUTER_WINDOW_MS)));
    if (week && t.id) {
      week.runs++;
      if (run.engine === "mod") week.mod++;
      week.suggested += suggested;
      week.accepted += accepted;
      if (note) week.notes++;
      if (delivered) week.delivered++;
    }
    if (!now) continue;
    r.runs++;
    outcomes[run.outcome]++;
    if (run.outcome === "ok" || run.outcome === "empty" || run.outcome === "bad-output")
      latencies.push(run.ms);
    if (run.fixes > 0) {
      r.fixes.runs++;
      r.fixes.total += run.fixes;
    }
    if (run.cost !== null) {
      r.cost.runs++;
      r.cost.usd += run.cost;
      r.cost.input += run.input ?? 0;
      r.cost.output += run.output ?? 0;
    }
    if (!t.id) {
      if (run.session) r.unjoined++;
      continue;
    }
    r.suggested += suggested;
    r.accepted += accepted;
    r.early += early;
    if (note) r.notes++;
    if (delivered) r.delivered++;
  }

  // Loads in turns the router read that it did not suggest; a skill loaded before in the
  // session is a reload, which the router never suggests.
  const missedBy = new Map<string, number>();
  for (const [id, list] of bySession) {
    const s = sessions.get(id);
    if (!s) continue;
    s.skills.forEach((load, i) => {
      if (!inCut(load.at)) return;
      const t = list.findLast((x) => x.start <= load.at && load.at < x.end);
      // A turn whose run gave no answer (a timeout, an error) had nothing to suggest.
      if (!t || (t.run.outcome !== "ok" && t.run.outcome !== "empty")) return;
      if (s.skills.slice(0, i).some((l) => l.name === load.name)) return;
      r.loads++;
      if (t.run.skills.includes(load.name)) return;
      r.missed++;
      missedBy.set(load.name, (missedBy.get(load.name) ?? 0) + 1);
    });
  }

  latencies.sort((a, b) => a - b);
  r.latency = { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) };
  r.bySkill = [...skillRows]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.suggested - a.suggested || a.name.localeCompare(b.name));
  r.missedTop = [...missedBy]
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  r.trend = [...trend.values()];
  return r;
}
