import type { Database } from "bun:sqlite";
import { z } from "zod";
import { objectiveKey, objectiveLabel } from "../../../shared/objectives.ts";
import type { Config } from "../../config.ts";
import { jsonOrNull } from "../../json.ts";
import { type Counts, costOf, LONG, priceOf } from "./pricing.ts";
import { type Filed, keyer, type Places, placesOf, tokensOf } from "./report.ts";
import type { Coverage, HistoryRow, PeriodRow, QuotaSample, UsagePeriod } from "./types.ts";

// What a quota week or a calendar month spent, hour by hour, for Consumo's chart; the page
// filters and colours the rows. The week is the plan's: it ends when the weekly limit resets.

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
// Claude Code counts a session from the moment its process starts; under this it is noise.
const MIN_CHECK_USD = 0.5;
// Ours over Claude Code's count by more than this: its count started after the session did.
const LATE = 1.1;
// A model Claude Code prices and nobody pays for.
const FREE_MODELS = new Set(["local"]);

export type PeriodQuery = { kind: "week" | "month"; offset: number };
type Bounds = { start: Date; end: Date };

// The first instant a weekly reset reaches after `now`: a reading older than its reset still
// tells the hour, a week on.
export function nextReset(resetAt: number, now: number): number {
  return resetAt + (Math.floor((now - resetAt) / WEEK) + 1) * WEEK;
}

// The bounds of the period `offset` back, and where the week's come from.
export function periodBounds(
  q: PeriodQuery,
  now: Date,
  weeklyResetAt: { at: string; from: "plan" | "sample" } | null,
): Bounds & { anchor: UsagePeriod["anchor"] } {
  const y = now.getFullYear();
  if (q.kind === "month") {
    const m = now.getMonth() - q.offset;
    return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1), anchor: "month" };
  }
  const reset = weeklyResetAt ? Date.parse(weeklyResetAt.at) : Number.NaN;
  if (weeklyResetAt && Number.isFinite(reset)) {
    const end = nextReset(reset, now.getTime()) - q.offset * WEEK;
    return { start: new Date(end - WEEK), end: new Date(end), anchor: weeklyResetAt.from };
  }
  // No plan reading: the local week, Monday to Monday.
  const monday = now.getDate() - ((now.getDay() + 6) % 7) - 7 * q.offset;
  return {
    start: new Date(y, now.getMonth(), monday),
    end: new Date(y, now.getMonth(), monday + 7),
    anchor: "monday",
  };
}

type HourRow = Counts & {
  harness: string;
  session_id: string;
  place_id: number;
  model: string;
  long: number;
  h: number;
};

const hoursOf = (b: Bounds) => Math.round((b.end.getTime() - b.start.getTime()) / HOUR);

// The calls between two instants by hour from the start, one row per harness, model,
// objective and project. The bounds cut inside an hour, so a reset at :30 splits it.
function rowsIn(
  db: Database,
  config: Config,
  places: Places,
  keyOf: ReturnType<typeof keyer>,
  b: Bounds,
  unpriced: Set<string>,
): PeriodRow[] {
  const start = b.start.toISOString();
  const last = hoursOf(b) - 1;
  const rows = db
    .query<HourRow, [string, string, string]>(
      `SELECT harness, session_id, place_id, model, ${LONG} AS long,
         CAST((julianday(at) - julianday(?1)) * 24 AS INTEGER) AS h, sum(input) AS input,
         sum(cache_read) AS cache_read, sum(cache_write) AS cache_write,
         sum(cache_write_1h) AS cache_write_1h, sum(output) AS output
       FROM agent_usage WHERE at >= ?2 AND at < ?3
       GROUP BY harness, session_id, place_id, model, long, h`,
    )
    .all(start, start, b.end.toISOString());
  const out = new Map<string, PeriodRow>();
  for (const r of rows) {
    const price = priceOf(config.pricing, r.model, Boolean(r.long));
    if (!price) unpriced.add(r.model);
    const h = Math.min(last, Math.max(0, r.h));
    const ticket = keyOf(r);
    const project = places.get(r.place_id)?.location ?? "";
    const key = `${h}\0${r.harness}\0${r.model}\0${ticket}\0${project}`;
    let row = out.get(key);
    if (!row) {
      row = { h, harness: r.harness, model: r.model, ticket, project, cost: null, tokens: 0 };
      out.set(key, row);
    }
    row.tokens += tokensOf(r);
    if (price) row.cost = (row.cost ?? 0) + costOf(price, r);
  }
  return [...out.values()];
}

const Models = z.record(z.string(), z.number()).catch({});

// Each Claude session that started in the period, our cost of all its calls against the last
// count Claude Code wrote for it. Errors never cancel out: a session short of its count adds
// to `outsideUsd`, one over it never takes away from another.
export function coverageOf(db: Database, config: Config, b: Bounds): Coverage | null {
  const checks = db
    .query<{ session_id: string; total_usd: number; models: string }, [string, string, number]>(
      `SELECT c.session_id, c.total_usd, c.models FROM agent_cost_checks c
       JOIN (SELECT session_id, min(at) AS first FROM agent_usage WHERE harness = 'claude'
             GROUP BY session_id) u ON u.session_id = c.session_id
       WHERE c.harness = 'claude' AND u.first >= ? AND u.first < ? AND c.total_usd >= ?`,
    )
    .all(b.start.toISOString(), b.end.toISOString(), MIN_CHECK_USD);
  const cover: Coverage = { sessions: 0, harnessUsd: 0, oursUsd: 0, outsideUsd: 0, late: 0 };
  const ours = db.query<Counts & { model: string; long: number }, [string]>(
    `SELECT model, ${LONG} AS long, sum(input) AS input, sum(cache_read) AS cache_read,
       sum(cache_write) AS cache_write, sum(cache_write_1h) AS cache_write_1h,
       sum(output) AS output
     FROM agent_usage WHERE harness = 'claude' AND session_id = ? GROUP BY model, long`,
  );
  for (const c of checks) {
    const models = Object.keys(Models.parse(jsonOrNull(c.models)));
    if (models.some((m) => FREE_MODELS.has(m))) continue;
    let usd = 0;
    for (const r of ours.all(c.session_id)) {
      const price = priceOf(config.pricing, r.model, Boolean(r.long));
      if (price) usd += costOf(price, r);
    }
    if (usd > c.total_usd * LATE) {
      cover.late++;
      continue;
    }
    cover.sessions++;
    cover.harnessUsd += c.total_usd;
    cover.oursUsd += usd;
    cover.outsideUsd += Math.max(0, c.total_usd - usd);
  }
  return cover.sessions + cover.late > 0 ? cover : null;
}

// How many quota weeks before the current one the projection learns from.
export const PROFILE_WEEKS = 4;

// The hours of the last PROFILE_WEEKS quota weeks, by harness and with or without a ticket:
// what a normal hour of the week costs, for the projection of an open period.
function historyOf(
  db: Database,
  config: Config,
  places: Places,
  keyOf: ReturnType<typeof keyer>,
  now: Date,
  reset: Reset,
  unpriced: Set<string>,
): UsagePeriod["history"] {
  const first = periodBounds({ kind: "week", offset: PROFILE_WEEKS }, now, reset);
  const last = periodBounds({ kind: "week", offset: 1 }, now, reset);
  const b = { start: first.start, end: last.end };
  const out = new Map<string, HistoryRow>();
  for (const r of rowsIn(db, config, places, keyOf, b, unpriced)) {
    const ticketed = r.ticket !== "";
    const key = `${r.h}\0${r.harness}\0${ticketed}`;
    let row = out.get(key);
    if (!row) {
      row = { h: r.h, harness: r.harness, ticketed, cost: null, tokens: 0 };
      out.set(key, row);
    }
    row.tokens += r.tokens;
    if (r.cost !== null) row.cost = (row.cost ?? 0) + r.cost;
  }
  return { start: b.start.toISOString(), weeks: PROFILE_WEEKS, rows: [...out.values()] };
}

type Reset = { at: string; from: "plan" | "sample" } | null;

// The bounds of the period asked for and of the one before it, from the plan's weekly reset
// or the last saved sample of it: the chart above and the sections below read the same ones.
export function periodCut(
  db: Database,
  q: PeriodQuery,
  plan: { weeklyResetAt: string | null; now?: Date },
) {
  const now = plan.now ?? new Date();
  const saved = plan.weeklyResetAt ? null : savedReset(db);
  const reset: Reset = plan.weeklyResetAt
    ? { at: plan.weeklyResetAt, from: "plan" }
    : saved
      ? { at: saved, from: "sample" }
      : null;
  return {
    now,
    reset,
    b: periodBounds(q, now, reset),
    before: periodBounds({ ...q, offset: q.offset + 1 }, now, reset),
  };
}

// The weekly reset in the last saved sample, for when the plan cannot be read now.
function savedReset(db: Database): string | null {
  return (
    db
      .query<{ reset_at: string }, []>(
        `SELECT reset_at FROM plan_samples
         WHERE harness = 'claude' AND window_minutes = 10080 AND reset_at IS NOT NULL
         ORDER BY at DESC LIMIT 1`,
      )
      .get()?.reset_at ?? null
  );
}

export function usagePeriod(
  db: Database,
  config: Config,
  q: PeriodQuery,
  plan: { weeklyResetAt: string | null; now?: Date },
  filed: Filed = new Map(),
): UsagePeriod {
  const { now, reset, b, before } = periodCut(db, q, plan);
  const places = placesOf(db, config);
  const keyOf = keyer(places, filed);
  const unpriced = new Set<string>();
  const rows = rowsIn(db, config, places, keyOf, b, unpriced);
  const quota = db
    .query<QuotaSample, [string, string]>(
      `SELECT harness, window_minutes AS minutes, at, percent, reset_at AS resetAt
       FROM plan_samples WHERE at >= ? AND at < ? ORDER BY at`,
    )
    .all(b.start.toISOString(), b.end.toISOString());
  const hours = hoursOf(b);
  const keys = new Set(rows.map((r) => r.ticket));
  const goals: Record<string, string> = {};
  for (const o of filed.values())
    if (o.kind === "goal" && keys.has(objectiveKey(o))) goals[objectiveKey(o)] = objectiveLabel(o);
  return {
    kind: q.kind,
    offset: q.offset,
    anchor: b.anchor,
    start: b.start.toISOString(),
    end: b.end.toISOString(),
    now: now.toISOString(),
    hours,
    elapsed: Math.min(hours, Math.max(0, Math.ceil((now.getTime() - b.start.getTime()) / HOUR))),
    rows,
    previous: {
      start: before.start.toISOString(),
      end: before.end.toISOString(),
      hours: hoursOf(before),
      rows: rowsIn(db, config, places, keyOf, before, unpriced),
    },
    quota,
    history: q.offset === 0 ? historyOf(db, config, places, keyOf, now, reset, new Set()) : null,
    coverage: coverageOf(db, config, b),
    goals,
    unpriced: [...unpriced].sort(),
  };
}
