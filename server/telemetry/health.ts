import type { Database } from "bun:sqlite";
import { SpanKind } from "@opentelemetry/api";
import { quantile } from "./histogram.ts";
import {
  type ErrorGroup,
  errorGroups,
  KEEP,
  liveBytes,
  measured,
  ROLLUPS,
  type SpanRow,
  summary,
} from "./store.ts";

// `aos trace health`: what changed, in one screen, for an agent starting work or checking its
// own change. Every finding names how sure it can be: a baseline too short to judge says so
// instead of passing for "no regressions".

const DAY = 86_400_000;
// The minutes after a start run cold (caches empty, CLIs loading): they would read as
// regressions every time the server restarts.
const COLD_MINUTES = 5;
// A regression: the p95 grew by both this share and this many ms, over enough calls in each
// window to mean it.
const GROWTH = 1.3;
const GROWTH_MS = 100;
const MIN_CALLS = 20;
// A wait with no span under it this long is worth instrumenting.
export const GAP_MS = 500;

export type Regression = {
  metric: string;
  key: string;
  now: number;
  base: number;
  nNow: number;
  nBase: number;
};
export type Health = {
  from: number;
  base: { from: number; to: number; days: number; wanted: number; enough: boolean };
  newErrors: ErrorGroup[];
  // Days of the baseline window the stored requests cover: under one, most errors read as new.
  errorBase: number;
  regressions: Regression[];
  heaviest: { metric: string; key: string; total: number; n: number }[];
  blind: { name: string; trace: string; blind: number; dur: number }[];
  loop: { p99: number; worst: number } | null;
  // `steady`: the size the file settles at with today's pace and the retention.
  space: { bytes: number; perDay: number | null; steady: number | null };
};

// Time a span spent on its own: its length minus the union of its children's, clipped to it.
// Children that ran in parallel (the repos of a project scan) count once.
export function exclusive(span: SpanRow, children: SpanRow[]): number {
  return gaps(span, children).reduce((sum, [s, e]) => sum + e - s, 0);
}

// The stretches of a span with no child running, as [start, end] in ms since the epoch.
export function gaps(span: SpanRow, children: SpanRow[]): [number, number][] {
  const end = span.start_ms + span.dur_ms;
  const parts = children
    .map((c) => [Math.max(c.start_ms, span.start_ms), Math.min(c.start_ms + c.dur_ms, end)])
    .filter(([s, e]) => (e ?? 0) > (s ?? 0))
    .sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0)) as [number, number][];
  const out: [number, number][] = [];
  let reach = span.start_ms;
  for (const [s, e] of parts) {
    if (s > reach) out.push([reach, s]);
    reach = Math.max(reach, e);
  }
  if (end > reach) out.push([reach, end]);
  return out;
}

// Only while histograms are kept by the minute: a folded row spans hours, and a start in it
// would drop them all.
const coldMinutes = (db: Database, from: number, now: number) => {
  const starts = db
    .query<{ minute: number }, [number]>(
      "SELECT minute FROM histo_minute WHERE metric = 'process' AND key = 'start' AND minute >= ?",
    )
    .all(
      Math.max(
        Math.floor(from / 60_000) - COLD_MINUTES,
        Math.ceil((now - (ROLLUPS[0]?.after ?? 0)) / 60_000),
      ),
    );
  return new Set(
    starts.flatMap(({ minute }) => [...Array(COLD_MINUTES).keys()].map((i) => minute + i)),
  );
};

export function health(db: Database, path: string, now: number, sinceMs: number, vsMs: number) {
  const from = now - sinceMs;
  const baseFrom = from - vsMs;
  // Cold minutes are left out of the comparison only: they are still where time went.
  const cold = coldMinutes(db, baseFrom, now);
  const all = measured(db, from, now);
  const recent = measured(db, from, now, cold);
  const before = measured(db, baseFrom, from, cold);

  // How much of the baseline window has data: a server that ran 10 hours of the last 7 days
  // judges regressions against those 10 hours, and says so.
  const minutes =
    db
      .query<{ n: number }, [number, number]>(
        "SELECT count(DISTINCT minute) AS n FROM histo_minute WHERE metric = 'route' AND minute >= ? AND minute < ?",
      )
      .get(Math.floor(baseFrom / 60_000), Math.floor(from / 60_000))?.n ?? 0;
  const days = minutes / 1440;
  const wanted = vsMs / DAY;

  const regressions: Regression[] = [];
  for (const [k, m] of recent) {
    const b = before.get(k);
    if (m.metric === "process" || !b || m.h.n < MIN_CALLS || b.h.n < MIN_CALLS) continue;
    const p95 = quantile(m.h, 0.95);
    const was = quantile(b.h, 0.95);
    if (p95 >= was * GROWTH && p95 - was >= GROWTH_MS)
      regressions.push({
        metric: m.metric,
        key: m.key,
        now: p95,
        base: was,
        nNow: m.h.n,
        nBase: b.h.n,
      });
  }
  regressions.sort((a, b) => b.now - b.base - (a.now - a.base));

  // Every failure of the baseline, not the newest few: a group missing there reads as new.
  const seen = new Set(
    db
      .query<{ k: string }, [number, number]>(
        "SELECT DISTINCT name || char(0) || coalesce(cause, '') AS k FROM roots WHERE status = 2 AND start_ms >= ? AND start_ms < ?",
      )
      .all(baseFrom, from)
      .map((r) => r.k),
  );
  const newErrors = errorGroups(db, from).filter((g) => !seen.has(`${g.name}\0${g.cause}`));
  const oldest = db
    .query<{ m: number | null }, []>("SELECT min(start_ms) AS m FROM roots")
    .get()?.m;
  const errorBase = Math.max(0, from - Math.max(baseFrom, oldest ?? from)) / DAY;

  const heaviest = [...all.values()]
    .filter((m) => m.metric !== "process")
    .map((m) => ({ metric: m.metric, key: m.key, total: m.h.sum, n: m.h.n }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const p99 = all.get("process\0event loop p99")?.h;
  const loop = p99?.n ? { p99: quantile(p99, 0.5), worst: p99.max } : null;

  return {
    from,
    base: { from: baseFrom, to: from, days, wanted, enough: days >= 1 },
    newErrors,
    errorBase,
    regressions,
    heaviest,
    blind: blindest(db, from),
    loop,
    space: space(db, path, now),
  } satisfies Health;
}

// The stored slow and failed requests with the most time under no span: where a wait is not
// instrumented yet (a lock, a sleep, a call the code makes without `traced`).
function blindest(db: Database, from: number): Health["blind"] {
  const spans = db
    .query<SpanRow, [number]>(
      `SELECT s.* FROM spans s JOIN roots r ON r.trace_id = s.trace_id
       WHERE r.start_ms >= ? AND r.kept IN ('slow', 'error') ORDER BY s.trace_id`,
    )
    .all(from);
  const byTrace = Map.groupBy(spans, (s) => s.trace_id);
  const out: Health["blind"] = [];
  for (const [trace, rows] of byTrace)
    for (const root of rows.filter((r) => r.local_root)) {
      const children = rows.filter((r) => r.parent_id === root.span_id);
      // A request's time with nothing under it is a wait, and so is a gap between a job's
      // calls; a background leaf's time is its own work.
      if (root.kind !== SpanKind.SERVER && !children.length) continue;
      const blind = exclusive(root, children);
      if (blind >= GAP_MS) out.push({ name: root.name, trace, blind, dur: root.dur_ms });
    }
  // One line per route: its worst trace.
  const worst = new Map<string, Health["blind"][number]>();
  for (const b of out.sort((x, y) => y.blind - x.blind))
    if (!worst.has(b.name)) worst.set(b.name, b);
  return [...worst.values()].slice(0, 5);
}

// The file's size now, what it writes a day and the size it settles at.
export function space(db: Database, path: string, now: number): Health["space"] {
  return { bytes: summary(db, path).bytes || liveBytes(db), ...pace(db, now) };
}

// What the file writes a day, at the pace since this process started (6 hours at most, so a
// change to what is kept shows after a restart), and the size that settles at once every kind
// of row is at its age: traces and minute rows for 30 days, then each histogram tier's rows.
// Bytes per row come from each table's pages, indexes included.
const PACE_MS = 6 * 3_600_000;
const PACE_MIN_MS = 30 * 60_000;
const TABLES = ["spans", "roots", "histo_minute"] as const;
function pace(db: Database, now: number): { perDay: number | null; steady: number | null } {
  const count = (sql: string, at: number) => db.query<{ n: number }, [number]>(sql).get(at)?.n ?? 0;
  const start = db
    .query<{ m: number | null }, []>(
      "SELECT max(minute) AS m FROM histo_minute WHERE metric = 'process' AND key = 'start'",
    )
    .get()?.m;
  const from = Math.max(now - PACE_MS, (start ?? 0) * 60_000);
  if (now - from < PACE_MIN_MS) return { perDay: null, steady: null };
  const perDayOf = (rows: number) => rows / ((now - from) / DAY);
  const minute = Math.floor(from / 60_000);
  const keys = count(
    "SELECT count(DISTINCT metric || char(0) || key) AS n FROM histo_minute WHERE minute >= ?",
    minute,
  );
  const traces = KEEP.traces / DAY;
  // [table, rows a day, days kept]
  const kinds: [(typeof TABLES)[number], number, number][] = [
    ["spans", perDayOf(count("SELECT count(*) AS n FROM spans WHERE start_ms >= ?", from)), traces],
    ["roots", perDayOf(count("SELECT count(*) AS n FROM roots WHERE start_ms >= ?", from)), traces],
    [
      "histo_minute",
      perDayOf(count("SELECT count(*) AS n FROM histo_minute WHERE minute >= ?", minute)),
      (ROLLUPS[0]?.after ?? 0) / DAY,
    ],
    ...ROLLUPS.map((t, i): [(typeof TABLES)[number], number, number] => [
      "histo_minute",
      (keys * 1_440) / t.minutes,
      ((ROLLUPS[i + 1]?.after ?? KEEP.histo) - t.after) / DAY,
    ]),
  ];
  const perRow = rowBytes(db);
  let steady = 0;
  for (const [table, rows, days] of kinds) steady += rows * days * (perRow.get(table) ?? 0);
  // Written a day: the first three, the rows as they arrive.
  const perDay = kinds
    .slice(0, 3)
    .reduce((sum, [table, rows]) => sum + rows * (perRow.get(table) ?? 0), 0);
  return { perDay, steady };
}

function rowBytes(db: Database): Map<string, number> {
  const rows = new Map(
    TABLES.map((t) => [
      t,
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()?.n ?? 0,
    ]),
  );
  let bytes: Map<string, number>;
  try {
    bytes = new Map(
      db
        .query<{ t: string; b: number }, []>(
          "SELECT s.tbl_name AS t, sum(d.pgsize) AS b FROM dbstat d JOIN sqlite_schema s ON s.name = d.name GROUP BY s.tbl_name",
        )
        .all()
        .map(({ t, b }) => [t, b]),
    );
  } catch {
    // A SQLite built without dbstat: every row at the file's average.
    const total = [...rows.values()].reduce((a, b) => a + b, 0);
    bytes = new Map(
      TABLES.map((t) => [t, total ? (liveBytes(db) * (rows.get(t) ?? 0)) / total : 0]),
    );
  }
  return new Map(TABLES.map((t) => [t, (bytes.get(t) ?? 0) / Math.max(1, rows.get(t) ?? 0)]));
}
