import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { emptyHisto, type Histo, merge, quantile } from "./histogram.ts";

// One file per writing process (the server's `telemetry.db`, the PTY host's own), apart from
// the app's database: spans never wait on the app's writes, and deleting the file loses only
// traces. Its schema is its own, versioned by `user_version`, not a migration.
// 3: histogram buckets became sparse and finer; a version 2 file keeps its spans and roots.
export const VERSION = 3;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS spans (
    seq INTEGER PRIMARY KEY,
    trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT,
    name TEXT NOT NULL, kind INTEGER NOT NULL, proc TEXT NOT NULL,
    start_ms REAL NOT NULL, dur_ms REAL NOT NULL,
    status INTEGER NOT NULL, error TEXT, local_root INTEGER NOT NULL, request_id TEXT,
    attrs TEXT NOT NULL, events TEXT NOT NULL,
    UNIQUE (trace_id, span_id)
  );
  CREATE INDEX IF NOT EXISTS spans_trace ON spans (trace_id);
  CREATE INDEX IF NOT EXISTS spans_start ON spans (start_ms);
  CREATE TABLE IF NOT EXISTS roots (
    seq INTEGER PRIMARY KEY,
    trace_id TEXT NOT NULL, request_id TEXT, name TEXT NOT NULL, proc TEXT NOT NULL,
    start_ms REAL NOT NULL, dur_ms REAL NOT NULL, status INTEGER NOT NULL, error TEXT,
    cause TEXT, kept TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS roots_start ON roots (start_ms);
  CREATE INDEX IF NOT EXISTS roots_request ON roots (request_id);
  CREATE INDEX IF NOT EXISTS roots_trace ON roots (trace_id);
  CREATE TABLE IF NOT EXISTS histo_minute (
    minute INTEGER NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL,
    n INTEGER NOT NULL, errors INTEGER NOT NULL, sum REAL NOT NULL, max REAL NOT NULL,
    buckets TEXT NOT NULL,
    PRIMARY KEY (minute, metric, key)
  ) WITHOUT ROWID;
`;

export const STATUS_ERROR = 2;

// An error with its ids, numbers and hashes as `#`: one failure is one group, whatever issue,
// port or time it names.
export const causeOf = (error: string | null) =>
  error
    ?.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+(\.\d+)?/g, "#") ?? null;

// Each writing process's own file in the data folder.
export const telemetryPath = (dataDir: string, proc: string) =>
  join(dataDir, proc === "host" ? "host-telemetry.db" : "telemetry.db");

export type SpanRow = {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  name: string;
  kind: number;
  proc: string;
  start_ms: number;
  dur_ms: number;
  status: number;
  error: string | null;
  local_root: number;
  request_id: string | null;
  attrs: string;
  events: string;
};
// One per request this process answered, kept or not: "not sampled" is an answer, "not found"
// would be a lie. `kept` says why its spans were stored: error, slow, sample, or "" (dropped).
export type RootRow = {
  trace_id: string;
  request_id: string | null;
  name: string;
  proc: string;
  start_ms: number;
  dur_ms: number;
  status: number;
  error: string | null;
  kept: string;
};
export type HistoRow = { minute: number; metric: string; key: string; h: Histo };

export function openTelemetry(path: string, readonly = false): Database {
  if (readonly) {
    const db = new Database(path, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 1000;");
    return db;
  }
  const fresh = path === ":memory:" || !existsSync(path);
  if (path !== ":memory:") closeSync(openSync(path, "a", 0o600));
  const db = new Database(path, { create: true, strict: true });
  // Space freed by pruning goes back to the disk only if this is set before the first table.
  if (fresh) db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 1000;");
  if (path !== ":memory:")
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  const version = versionOf(db);
  if (version !== VERSION) {
    // Traces are a cache of the last days: an older layout is dropped, never migrated. From 2,
    // only the minute histograms changed shape.
    db.exec(
      version === 2
        ? "DROP TABLE IF EXISTS histo_minute;"
        : "DROP TABLE IF EXISTS spans; DROP TABLE IF EXISTS roots; DROP TABLE IF EXISTS histo_minute;",
    );
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${VERSION};`);
  }
  return db;
}

export function writeBatch(db: Database, spans: SpanRow[], roots: RootRow[], histos: HistoRow[]) {
  const span = db.query(
    `INSERT OR IGNORE INTO spans (trace_id, span_id, parent_id, name, kind, proc, start_ms, dur_ms,
       status, error, local_root, request_id, attrs, events)
     VALUES ($trace_id, $span_id, $parent_id, $name, $kind, $proc, $start_ms, $dur_ms, $status,
       $error, $local_root, $request_id, $attrs, $events)`,
  );
  const root = db.query(
    `INSERT INTO roots (trace_id, request_id, name, proc, start_ms, dur_ms, status, error, cause, kept)
     VALUES ($trace_id, $request_id, $name, $proc, $start_ms, $dur_ms, $status, $error, $cause,
       $kept)`,
  );
  const old = db.query<
    { n: number; errors: number; sum: number; max: number; buckets: string },
    [number, string, string]
  >(
    "SELECT n, errors, sum, max, buckets FROM histo_minute WHERE minute = ? AND metric = ? AND key = ?",
  );
  const histo = db.query(
    `INSERT OR REPLACE INTO histo_minute (minute, metric, key, n, errors, sum, max, buckets)
     VALUES ($minute, $metric, $key, $n, $errors, $sum, $max, $buckets)`,
  );
  db.transaction(() => {
    for (const s of spans) span.run(s);
    for (const r of roots) root.run({ ...r, cause: causeOf(r.error) });
    // A minute written again (a flush on exit, then the rest after a restart) adds up.
    for (const { minute, metric, key, h } of histos) {
      const was = old.get(minute, metric, key);
      const sum = was ? merge(fromRow(was), h) : h;
      histo.run({ minute, metric, key, ...sum, buckets: JSON.stringify(sum.buckets) });
    }
  })();
}

const fromRow = (r: {
  n: number;
  errors: number;
  sum: number;
  max: number;
  buckets: string;
}): Histo => ({
  ...emptyHisto(),
  ...r,
  buckets: JSON.parse(r.buckets) as Record<number, number>,
});

// The layout a file was written with: a reader opened read-only cannot upgrade it, and the
// server does that on its next start.
export const versionOf = (db: Database) =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

// How long rows are kept. Traces, whole, for 30 days. The minute histograms thin out with
// age: every minute for 30 days (the baseline a regression is judged against stays exact), one
// row per 3 hours to 90 days and one a day to 180, so a trend over months stays cheap.
const DAY = 86_400_000;
export const KEEP = { traces: 30 * DAY, histo: 180 * DAY };
export const ROLLUPS = [
  { after: 30 * DAY, minutes: 180 },
  { after: 90 * DAY, minutes: 1_440 },
] as const;
// A safety net, not the plan: the retention above settles well under it, and `aos trace
// health` and `status` say where.
export const BUDGET_BYTES = 300 * 1024 * 1024;
// Histogram groups folded per call: prune runs hourly, so this only bounds a catch-up.
const FOLD_LIMIT = 5_000;

// Drops what is past its age, folds old histograms, then cuts whole days of traces from the
// oldest while the file is over `maxBytes`, in bounded deletes so the event loop is never held
// long.
export function prune(db: Database, now: number, maxBytes: number): number {
  let gone = 0;
  for (const t of ["spans", "roots"]) {
    const q = db.query(
      `DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE start_ms < ? LIMIT 5000)`,
    );
    for (let n = q.run(now - KEEP.traces).changes; n > 0; n = q.run(now - KEEP.traces).changes)
      gone += n;
  }
  gone += db
    .query("DELETE FROM histo_minute WHERE minute < ?")
    .run(Math.floor((now - KEEP.histo) / 60_000)).changes;
  gone += rollup(db, now);
  for (let i = 0; i < 30 && liveBytes(db) > maxBytes; i++) {
    const first = db
      .query<{ m: number | null }, []>(
        "SELECT min(m) AS m FROM (SELECT min(start_ms) AS m FROM spans UNION ALL SELECT min(start_ms) FROM roots)",
      )
      .get()?.m;
    if (first == null) break;
    for (const t of ["spans", "roots"])
      gone += db.query(`DELETE FROM ${t} WHERE start_ms < ?`).run(first + DAY).changes;
  }
  db.exec("PRAGMA incremental_vacuum(2000);");
  return gone;
}

// Folds each histogram's rows past a tier's age into one row per step of that tier, at the
// step's first minute. A group already folded (one row, at its start) is left alone, so a
// later call only touches the minutes that aged since. Returns the rows removed.
export function rollup(db: Database, now: number): number {
  let gone = 0;
  for (const { after, minutes: step } of ROLLUPS) {
    const minute = Math.floor((now - after) / 60_000);
    const before = minute - (minute % step);
    const groups = db
      .query<{ b: number; metric: string; key: string }, [number, number, number]>(
        `SELECT minute - (minute % ?1) AS b, metric, key FROM histo_minute WHERE minute < ?2
         GROUP BY b, metric, key HAVING count(*) > 1 OR min(minute) != b LIMIT ?3`,
      )
      .all(step, before, FOLD_LIMIT);
    const rows = db.query<
      { n: number; errors: number; sum: number; max: number; buckets: string },
      [string, string, number, number]
    >(
      "SELECT n, errors, sum, max, buckets FROM histo_minute WHERE metric = ? AND key = ? AND minute >= ? AND minute < ?",
    );
    const drop = db.query(
      "DELETE FROM histo_minute WHERE metric = ? AND key = ? AND minute >= ? AND minute < ?",
    );
    db.transaction(() => {
      for (const { b, metric, key } of groups) {
        const h = rows
          .all(metric, key, b, b + step)
          .reduce((sum, r) => merge(sum, fromRow(r)), emptyHisto());
        gone += drop.run(metric, key, b, b + step).changes - 1;
        writeBatch(db, [], [], [{ minute: b, metric, key, h }]);
      }
    })();
  }
  return gone;
}

// The bytes rows take, without the pages a delete freed and the disk has not got back yet.
export function liveBytes(db: Database): number {
  const pragma = (name: string) =>
    (db.query(`PRAGMA ${name}`).get() as Record<string, number> | null)?.[name] ?? 0;
  return (pragma("page_count") - pragma("freelist_count")) * (pragma("page_size") || 4096);
}

// Reads, shared by the API and by `aos trace`, which opens the file itself when the server is
// down.

export type ErrorGroup = {
  name: string;
  cause: string;
  error: string;
  count: number;
  last: number;
  trace: string;
};
export function errorGroups(db: Database, since: number): ErrorGroup[] {
  return db
    .query<ErrorGroup, [number]>(
      `SELECT name, coalesce(cause, '') AS cause, count(*) AS count, max(start_ms) AS last,
         (SELECT coalesce(r2.error, '') FROM roots r2 WHERE r2.name = r.name
            AND coalesce(r2.cause, '') = coalesce(r.cause, '') AND r2.status = 2
            ORDER BY r2.start_ms DESC LIMIT 1) AS error,
         (SELECT r2.trace_id FROM roots r2 WHERE r2.name = r.name
            AND coalesce(r2.cause, '') = coalesce(r.cause, '') AND r2.status = 2
            ORDER BY r2.kept != '' DESC, r2.start_ms DESC LIMIT 1) AS trace
       FROM roots r WHERE status = 2 AND start_ms >= ? GROUP BY name, coalesce(cause, '')
       ORDER BY last DESC, name LIMIT 30`,
    )
    .all(since);
}

export type Measured = { metric: string; key: string; h: Histo };

// Each route's, outside call's and process measure's durations over [from, to), minutes in
// `skip` left out (the cold minutes after a start).
export function measured(
  db: Database,
  from: number,
  to = Number.POSITIVE_INFINITY,
  skip: Set<number> = new Set(),
): Map<string, Measured> {
  const rows = db
    .query<
      {
        minute: number;
        metric: string;
        key: string;
        n: number;
        errors: number;
        sum: number;
        max: number;
        buckets: string;
      },
      [number, number]
    >(
      "SELECT minute, metric, key, n, errors, sum, max, buckets FROM histo_minute WHERE minute >= ? AND minute < ?",
    )
    .all(Math.floor(from / 60_000), Number.isFinite(to) ? Math.floor(to / 60_000) : 2 ** 52);
  const by = new Map<string, Measured>();
  for (const r of rows) {
    if (skip.has(r.minute)) continue;
    const k = `${r.metric}\0${r.key}`;
    const was = by.get(k);
    if (was) merge(was.h, fromRow(r));
    else by.set(k, { metric: r.metric, key: r.key, h: fromRow(r) });
  }
  return by;
}

export type SlowRow = {
  metric: string;
  key: string;
  n: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  // Time spent in all of them, in ms: where the hours go.
  total: number;
  trace: string | null;
};
export function slowest(
  db: Database,
  since: number,
  limit = 15,
  by: "p95" | "total" = "p95",
): SlowRow[] {
  const worst = db.query<{ trace_id: string }, [string, number]>(
    "SELECT trace_id FROM roots WHERE name = ? AND kept != '' AND start_ms >= ? ORDER BY dur_ms DESC LIMIT 1",
  );
  return [...measured(db, since).values()]
    .filter(({ key }) => key !== "start")
    .map(({ metric, key, h }) => ({
      metric,
      key,
      n: h.n,
      errors: h.errors,
      p50: quantile(h, 0.5),
      p95: quantile(h, 0.95),
      max: h.max,
      total: h.sum,
      trace: metric === "route" ? (worst.get(key, since)?.trace_id ?? null) : null,
    }))
    .sort((a, b) => (by === "total" ? b.total - a.total : b.p95 - a.p95))
    .slice(0, limit);
}

// A trace id, or a request id that leads to one.
export function traceOf(db: Database, id: string): { root: RootRow | null; spans: SpanRow[] } {
  const root =
    db
      .query<RootRow, [string, string]>(
        "SELECT * FROM roots WHERE request_id = ? OR trace_id = ? ORDER BY start_ms LIMIT 1",
      )
      .get(id, id) ?? null;
  const trace = root?.trace_id ?? id;
  const spans = db
    .query<SpanRow, [string]>("SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ms")
    .all(trace);
  return { root, spans };
}

// What came in after a cursor (the roots' sequence, not the clock, so a late batch is not
// missed): failures and kept slow requests, and the cursor to ask from next time.
export function since(
  db: Database,
  cursor: number,
): { roots: (RootRow & { seq: number })[]; cursor: number } {
  const roots = db
    .query<RootRow & { seq: number }, [number]>(
      "SELECT * FROM roots WHERE seq > ? AND (status = 2 OR kept = 'slow') ORDER BY seq LIMIT 200",
    )
    .all(cursor);
  const last = db.query<{ m: number | null }, []>("SELECT max(seq) AS m FROM roots").get()?.m ?? 0;
  return { roots, cursor: last };
}

export function summary(db: Database, path: string) {
  const one = <T>(sql: string) => db.query<T, []>(sql).get();
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    // :memory: or gone.
  }
  return {
    bytes,
    spans: one<{ n: number }>("SELECT count(*) AS n FROM spans")?.n ?? 0,
    roots: one<{ n: number }>("SELECT count(*) AS n FROM roots")?.n ?? 0,
    oldest: one<{ m: number | null }>("SELECT min(start_ms) AS m FROM roots")?.m ?? null,
    newest: one<{ m: number | null }>("SELECT max(start_ms) AS m FROM roots")?.m ?? null,
    procs: db
      .query<{ proc: string }, []>("SELECT DISTINCT proc FROM roots")
      .all()
      .map((r) => r.proc),
  };
}

// Each route's (or outside call's) durations over a window, for the "slower than usual" test.
export const routeHistos = (db: Database, since: number, metric = "route") =>
  new Map(
    [...measured(db, since).values()].filter((m) => m.metric === metric).map((m) => [m.key, m.h]),
  );
