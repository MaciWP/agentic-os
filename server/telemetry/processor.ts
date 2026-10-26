import { type Context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";
import { withoutQuery } from "../log.ts";
import { emptyHisto, type Histo, quantile, record } from "./histogram.ts";
import { causeOf, type HistoRow, type RootRow, type SpanRow, STATUS_ERROR } from "./store.ts";

// Tail sampling: a request's spans wait in memory until its local root (the request as this
// process saw it, with or without a remote parent) ends, and then are kept whole or dropped.
// Kept: any error; slower than its route usually is; or 1 trace in SAMPLE by its id, the same
// pick in every process, up to SAMPLES_PER_HOUR per route. Durations go to minute histograms for every request, kept or not.

export const SAMPLE = 20;
// Healthy samples stored per route and hour: the screens poll every few seconds, and the
// hundredth copy of a 2 ms poll shows nothing the second did not.
export const SAMPLES_PER_HOUR = 2;
export const MAX_SPANS_PER_TRACE = 256;
// A healthy sample shows the shape of a normal request: its longest spans say it, and a scan of
// every repo would otherwise store dozens of near-identical git calls each time.
export const SAMPLE_SPANS = 64;
export const MAX_OPEN_TRACES = 2_000;
export const MAX_OPEN_BYTES = 8 * 1024 * 1024;
// A trace whose root never ended (a stream that slipped through, a hung call) is let go.
export const OPEN_MAX_MS = 120_000;
// Spans that end after their trace was decided follow the decision for this long.
export const DECIDED_MS = 5 * 60_000;
// Slow traces stored per route and hour: routes that are always slow must not fill the file.
export const SLOW_PER_HOUR = 6;
// Full error traces stored per route, cause and hour: a failure that repeats every few seconds
// (a machine's engine down) is counted in full, and kept whole only this often.
export const ERRORS_PER_HOUR = 6;
const WRITE_BATCH = 500;
const MAX_QUEUE = 20_000;
const VALUE_MAX = 300;

export type Write = (spans: SpanRow[], roots: RootRow[], histos: HistoRow[]) => void;
export type Options = { proc: string; write: Write; now?: () => number; tickMs?: number };

type Open = { rows: SpanRow[]; bytes: number; first: number; error: string | null };

// A floor per method: under it a request is never "slow", whatever its route's p95.
const floorOf = (name: string) => (name.startsWith("GET ") ? 300 : 1_000);
const sampled = (traceId: string) => Number.parseInt(traceId.slice(-8), 16) % SAMPLE === 0;

const value = (v: unknown) =>
  typeof v === "string"
    ? withoutQuery(v).slice(0, VALUE_MAX)
    : typeof v === "number" || typeof v === "boolean"
      ? v
      : String(v).slice(0, VALUE_MAX);
const clean = (attrs: Record<string, unknown> = {}) =>
  JSON.stringify(Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, value(v)])));

export class TailProcessor implements SpanProcessor {
  readonly stats = { kept: 0, dropped: 0, lost: 0, lastWrite: 0, lastError: "" };
  // Until then every request is stored whole, for a test run: `aos trace full`.
  fullUntil = 0;
  private readonly open = new Map<string, Open>();
  private openBytes = 0;
  private readonly decided = new Map<string, { keep: boolean; at: number }>();
  private spans: SpanRow[] = [];
  private roots: RootRow[] = [];
  private minutes = new Map<string, HistoRow>();
  private readonly slowCount = new Map<string, number>();
  private readonly errorCount = new Map<string, number>();
  private readonly sampleCount = new Map<string, number>();
  private p95 = new Map<string, number>();
  // Outside calls still running: a call made inside another (the `open` under a Mac helper
  // call) is timed once, as the outer one.
  private readonly calls = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private soon: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: Options) {
    this.now = opts.now ?? Date.now;
    this.timer = setInterval(() => this.tick(), opts.tickMs ?? 2_000);
    this.timer.unref?.();
  }

  onStart(span: Span, _parent: Context): void {
    if (span.attributes["aos.op"] !== undefined && this.calls.size < MAX_OPEN_TRACES)
      this.calls.add(span.spanContext().spanId);
  }

  onEnd(span: ReadableSpan): void {
    const row = this.row(span);
    const isError = row.status === STATUS_ERROR;
    this.calls.delete(row.span_id);
    const nested = row.parent_id !== null && this.calls.has(row.parent_id);
    this.measure(row, nested ? undefined : span.attributes["aos.op"]);
    // A later request in an already decided trace (the server calling the PC twice) still
    // gets its own root row and decision; only the spans under it follow the earlier one.
    const done = row.local_root ? undefined : this.decided.get(row.trace_id);
    if (done) {
      if (done.keep) this.queue([row], isError);
      return;
    }
    let t = this.open.get(row.trace_id);
    if (!t) {
      t = { rows: [], bytes: 0, first: this.now(), error: null };
      this.open.set(row.trace_id, t);
    }
    if (isError && !t.error) t.error = `${row.name}: ${row.error ?? "error"}`.slice(0, VALUE_MAX);
    // Past the cap, the root and the errors still get in: they are what a reader looks for.
    if (t.rows.length < MAX_SPANS_PER_TRACE || isError || row.local_root) {
      const bytes = row.attrs.length + row.events.length + 200;
      t.rows.push(row);
      t.bytes += bytes;
      this.openBytes += bytes;
    } else this.stats.dropped++;
    if (row.local_root) this.decide(row, t);
    this.bound();
  }

  private row(span: ReadableSpan): SpanRow {
    const ctx = span.spanContext();
    const parent = span.parentSpanContext;
    const start = hrTimeToMilliseconds(span.startTime);
    const exception = span.events.find((e) => e.name === "exception")?.attributes?.[
      "exception.message"
    ];
    const error =
      span.status.code === SpanStatusCode.ERROR
        ? value(span.status.message || exception || "error").toString()
        : null;
    return {
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
      parent_id: parent?.spanId ?? null,
      name: span.name.slice(0, 200),
      kind: span.kind,
      proc: this.opts.proc,
      start_ms: start,
      dur_ms: hrTimeToMilliseconds(span.duration),
      status: span.status.code,
      error,
      local_root: !parent || parent.isRemote ? 1 : 0,
      request_id:
        typeof span.attributes["request.id"] === "string" ? span.attributes["request.id"] : null,
      attrs: clean(span.attributes),
      events: JSON.stringify(
        // The event's own fields first: a log line's `ms` never hides when it happened.
        span.events.map((e) => ({
          ...JSON.parse(clean(e.attributes)),
          name: e.name,
          at_ms: Math.round(hrTimeToMilliseconds(e.time) - start),
        })),
      ),
    };
  }

  // Every request by its route, every outside call by its name: 100 %, before sampling.
  private measure(row: SpanRow, op: unknown): void {
    // Background work (a timed ingest, a watcher's git call) is no request: it is timed as the
    // outside call it is, never in a route's p95.
    const metric = row.kind === SpanKind.SERVER ? "route" : typeof op === "string" ? "op" : null;
    if (metric) this.add(metric, row.name, row.start_ms, row.dur_ms, row.status === STATUS_ERROR);
  }

  // A measure of the process itself, once a minute: how late the event loop ran its timers.
  gauge(key: string, ms: number): void {
    this.add("process", key, this.now(), ms, false);
  }

  private add(metric: string, key: string, at: number, ms: number, error: boolean): void {
    const minute = Math.floor(at / 60_000);
    const k = `${minute}\0${metric}\0${key}`;
    let m = this.minutes.get(k);
    if (!m) {
      m = { minute, metric, key, h: emptyHisto() };
      this.minutes.set(k, m);
    }
    record(m.h, ms, error);
  }

  private decide(root: SpanRow, t: Open): void {
    const hour = Math.floor(root.start_ms / 3_600_000);
    const slowKey = `${root.name}\0${hour}`;
    const usual = Math.max(floorOf(root.name), this.p95.get(root.name) ?? 0);
    const slow = root.dur_ms >= usual && (this.slowCount.get(slowKey) ?? 0) < SLOW_PER_HOUR;
    const errorKey = `${slowKey}\0${causeOf(t.error)}`;
    const error = t.error !== null && (this.errorCount.get(errorKey) ?? 0) < ERRORS_PER_HOUR;
    const full = this.fullUntil > this.now();
    const sample =
      full || (sampled(root.trace_id) && (this.sampleCount.get(slowKey) ?? 0) < SAMPLES_PER_HOUR);
    const kept = error ? "error" : slow ? "slow" : sample ? "sample" : "";
    if (kept === "slow") this.slowCount.set(slowKey, (this.slowCount.get(slowKey) ?? 0) + 1);
    if (kept === "error") this.errorCount.set(errorKey, (this.errorCount.get(errorKey) ?? 0) + 1);
    if (kept === "sample") this.sampleCount.set(slowKey, (this.sampleCount.get(slowKey) ?? 0) + 1);
    // A fast, correct read or background run is already counted and timed in the minute
    // histograms: its own line would be most of the file (the screens poll every few seconds)
    // and answer nothing. Writes always keep theirs.
    const write = root.kind === SpanKind.SERVER && !root.name.startsWith("GET ");
    if (kept || write || t.error)
      this.roots.push({
        trace_id: root.trace_id,
        request_id: root.request_id,
        name: root.name,
        proc: root.proc,
        start_ms: root.start_ms,
        dur_ms: root.dur_ms,
        status: t.error ? STATUS_ERROR : root.status,
        error: t.error,
        kept,
      });
    this.close(root.trace_id, t, kept !== "");
    if (kept) this.queue(kept === "sample" && !full ? this.trim(t.rows) : t.rows, kept === "error");
  }

  // The root, any error and the longest of the rest, in their original order.
  private trim(rows: SpanRow[]): SpanRow[] {
    if (rows.length <= SAMPLE_SPANS) return rows;
    const must = rows.filter((r) => r.local_root || r.status === STATUS_ERROR);
    const rest = rows
      .filter((r) => !must.includes(r))
      .sort((a, b) => b.dur_ms - a.dur_ms)
      .slice(0, Math.max(0, SAMPLE_SPANS - must.length));
    const keep = new Set([...must, ...rest]);
    this.stats.dropped += rows.length - keep.size;
    return rows.filter((r) => keep.has(r));
  }

  private close(traceId: string, t: Open, keep: boolean): void {
    this.open.delete(traceId);
    this.openBytes -= t.bytes;
    this.decided.set(traceId, { keep, at: this.now() });
    if (keep) this.stats.kept++;
  }

  // Memory has a ceiling: the oldest open traces go first, kept only if they hold an error.
  private bound(): void {
    for (const [id, t] of this.open) {
      if (this.open.size <= MAX_OPEN_TRACES && this.openBytes <= MAX_OPEN_BYTES) return;
      this.close(id, t, t.error !== null);
      if (t.error) this.incomplete(t);
      else this.stats.dropped += t.rows.length;
    }
  }

  private incomplete(t: Open): void {
    const first = t.rows[0];
    if (first)
      this.roots.push({
        trace_id: first.trace_id,
        request_id: first.request_id,
        name: first.name,
        proc: this.opts.proc,
        start_ms: first.start_ms,
        dur_ms: 0,
        status: STATUS_ERROR,
        error: t.error,
        kept: "incomplete",
      });
    this.queue(t.rows, true);
  }

  private queue(rows: SpanRow[], now: boolean): void {
    for (const r of rows) {
      if (this.spans.length >= MAX_QUEUE) this.stats.lost++;
      else this.spans.push(r);
    }
    // An error is written at once: the process may be about to die of it.
    if (now && !this.soon) {
      this.soon = setTimeout(() => {
        this.soon = undefined;
        this.write(false);
      }, 0);
      this.soon.unref?.();
    }
  }

  tick(): void {
    const now = this.now();
    for (const [id, t] of this.open)
      if (now - t.first > OPEN_MAX_MS) {
        this.close(id, t, t.error !== null);
        if (t.error) this.incomplete(t);
      }
    for (const [id, d] of this.decided) {
      if (now - d.at <= DECIDED_MS) break;
      this.decided.delete(id);
    }
    // The hourly caps only look at their own hour: older counters go.
    const hour = Math.floor(now / 3_600_000);
    for (const counts of [this.slowCount, this.errorCount, this.sampleCount])
      for (const k of counts.keys()) if (Number(k.split("\0")[1]) < hour - 1) counts.delete(k);
    this.write(false);
  }

  // `all` also writes the minute still running and every queued span: on exit.
  write(all: boolean): void {
    const minute = Math.floor(this.now() / 60_000);
    const histos: HistoRow[] = [];
    for (const [k, m] of this.minutes)
      if (all || m.minute < minute) {
        histos.push(m);
        this.minutes.delete(k);
      }
    const spans = all ? this.spans.splice(0) : this.spans.splice(0, WRITE_BATCH);
    const roots = this.roots.splice(0);
    if (!spans.length && !roots.length && !histos.length) return;
    try {
      this.opts.write(spans, roots, histos);
      this.stats.lastWrite = this.now();
    } catch (err) {
      // Telemetry never breaks the app: a failed write is counted and let go.
      this.stats.lost += spans.length + roots.length;
      this.stats.lastError = value(err instanceof Error ? err.message : err).toString();
    }
  }

  // The per-route p95 that makes a request "slow" for its route, from the last hour.
  usual(p95: Map<string, Histo>): void {
    this.p95 = new Map([...p95].map(([k, h]) => [k, quantile(h, 0.95)]));
  }

  forceFlush(): Promise<void> {
    this.write(true);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    clearInterval(this.timer);
    return this.forceFlush();
  }
}
