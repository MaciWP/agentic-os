import { expect, test } from "bun:test";
import { gaps, health } from "./health.ts";
import { emptyHisto, record } from "./histogram.ts";
import { type HistoRow, openTelemetry, type RootRow, type SpanRow, writeBatch } from "./store.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const DAY = 86_400_000;
const minuteOf = (at: number) => Math.floor(at / 60_000);

const histo = (minute: number, key: string, ms: number, n = 1, metric = "route"): HistoRow => {
  const h = emptyHisto();
  for (let i = 0; i < n; i++) record(h, ms, false);
  return { minute, metric, key, h };
};
const root = (over: Partial<RootRow>): RootRow => ({
  trace_id: "t",
  request_id: null,
  name: "GET /a",
  proc: "server",
  start_ms: NOW - 60_000,
  dur_ms: 5,
  status: 2,
  error: "boom",
  kept: "error",
  ...over,
});
const span = (over: Partial<SpanRow>): SpanRow => ({
  trace_id: "slow1",
  span_id: "r",
  parent_id: null,
  name: "GET /api/projects",
  kind: 1,
  proc: "server",
  start_ms: NOW - 120_000,
  dur_ms: 6_000,
  status: 0,
  error: null,
  local_root: 1,
  request_id: null,
  attrs: "{}",
  events: "[]",
  ...over,
});

// A day of baseline at 100 ms, the last hour at 400 ms; one call 5 s in a cold minute.
function filled() {
  const db = openTelemetry(":memory:");
  const base = Array.from({ length: 1_500 }, (_, i) =>
    histo(minuteOf(NOW - 2 * DAY) + i, "GET /api/git/summary", 100),
  );
  const recent = Array.from({ length: 30 }, (_, i) =>
    histo(minuteOf(NOW - 3_600_000) + i, "GET /api/git/summary", 400),
  );
  const startMinute = minuteOf(NOW - 600_000);
  writeBatch(
    db,
    [
      span({}),
      span({ span_id: "c", parent_id: "r", name: "zsh login env", local_root: 0, dur_ms: 1_000 }),
    ],
    [
      root({ trace_id: "old", name: "GET /a", start_ms: NOW - 2 * DAY }),
      root({ trace_id: "again", name: "GET /a", start_ms: NOW - 3_600_000 }),
      root({ trace_id: "fresh", name: "GET /b", error: "new failure", start_ms: NOW - 600_000 }),
      root({
        trace_id: "slow1",
        name: "GET /api/projects",
        status: 0,
        error: null,
        kept: "slow",
        start_ms: NOW - 120_000,
        dur_ms: 6_000,
      }),
    ],
    [
      ...base,
      ...recent,
      histo(startMinute, "start", 0, 1, "process"),
      histo(startMinute + 1, "GET /api/cold", 5_000, 25),
      histo(minuteOf(NOW - 60_000), "event loop p99", 12, 1, "process"),
    ],
  );
  return db;
}

test("a slower p95 than the baseline is a regression; cold minutes after a start are not", () => {
  const h = health(filled(), ":memory:", NOW, DAY, 7 * DAY);
  expect(h.base.enough).toBe(true);
  expect(h.regressions.map((r) => r.key)).toEqual(["GET /api/git/summary"]);
  // Left out of the comparison, still counted where time went.
  expect(h.heaviest[0]?.key).toBe("GET /api/cold");
  expect(h.loop?.worst).toBe(12);
});

test("errors seen in the baseline are not new; a first failure is", () => {
  const h = health(filled(), ":memory:", NOW, DAY, 7 * DAY);
  expect(h.newErrors.map((g) => g.name)).toEqual(["GET /b"]);
  // The oldest stored request is 2 days old: one day of the baseline is covered.
  expect(h.errorBase).toBe(1);
});

test("time under no span in a stored slow request is named, with its trace", () => {
  const h = health(filled(), ":memory:", NOW, DAY, 7 * DAY);
  expect(h.blind).toEqual([
    { name: "GET /api/projects", trace: "slow1", blind: 5_000, dur: 6_000 },
  ]);
});

test("a background call's own time is its work, not a blind wait", () => {
  const db = openTelemetry(":memory:");
  writeBatch(
    db,
    [span({ trace_id: "bg", name: "cache refresh", kind: 0 })],
    [root({ trace_id: "bg", name: "cache refresh", status: 0, error: null, kept: "slow" })],
    [],
  );
  expect(health(db, ":memory:", NOW, DAY, 7 * DAY).blind).toEqual([]);
});

test("a gap between a background job's calls is blind time", () => {
  const db = openTelemetry(":memory:");
  writeBatch(
    db,
    [
      span({ trace_id: "job", name: "cache refresh", kind: 0 }),
      span({
        trace_id: "job",
        span_id: "c",
        parent_id: "r",
        name: "envctl list",
        local_root: 0,
        dur_ms: 1_000,
      }),
    ],
    [root({ trace_id: "job", name: "cache refresh", status: 0, error: null, kept: "slow" })],
    [],
  );
  expect(health(db, ":memory:", NOW, DAY, 7 * DAY).blind).toEqual([
    { name: "cache refresh", trace: "job", blind: 5_000, dur: 6_000 },
  ]);
});

test("a baseline under a day is not enough to call anything a regression", () => {
  const db = openTelemetry(":memory:");
  writeBatch(db, [], [], [histo(minuteOf(NOW - 2 * DAY), "GET /x", 10, 30)]);
  const h = health(db, ":memory:", NOW, DAY, 7 * DAY);
  expect([h.base.enough, h.base.days < 1]).toEqual([false, true]);
});

test("the file settles at each kind's daily bytes times how long it is kept", () => {
  const db = openTelemetry(":memory:");
  const plain = Array.from({ length: 600 }, (_, i) =>
    root({ trace_id: `w${i}`, status: 0, error: null, kept: "", start_ms: NOW - i * 30_000 }),
  );
  writeBatch(db, [], plain, [histo(minuteOf(NOW - 7 * 3_600_000), "start", 0, 1, "process")]);
  const { perDay, steady } = health(db, ":memory:", NOW, DAY, 7 * DAY).space;
  expect(perDay).toBeGreaterThan(0);
  // Only request lines in the last 6 hours, and no histogram key: all kept 30 days.
  expect((steady ?? 0) / (perDay ?? 1)).toBeCloseTo(30);
});

test("the pace waits half an hour after a start", () => {
  const db = openTelemetry(":memory:");
  writeBatch(db, [], [], [histo(minuteOf(NOW - 10 * 60_000), "start", 0, 1, "process")]);
  expect(health(db, ":memory:", NOW, DAY, 7 * DAY).space).toMatchObject({
    perDay: null,
    steady: null,
  });
});

test("gaps are the stretches with no child running", () => {
  const parent = span({ start_ms: 0, dur_ms: 1_000 });
  const kids = [span({ start_ms: 100, dur_ms: 200 }), span({ start_ms: 250, dur_ms: 100 })];
  expect(gaps(parent, kids)).toEqual([
    [0, 100],
    [350, 1_000],
  ]);
});
