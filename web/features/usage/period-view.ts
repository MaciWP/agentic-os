import type { HistoryRow, PeriodRow, UsagePeriod } from "../../../server/features/usage/types.ts";

// What the period panel draws, from the rows the server sends: the filters, the colour of each
// series, the running totals hour by hour, the pace and where it ends. Pure, so it is tested
// without a page.

export type Scope = "all" | "ticket" | "none";
export type ColorBy = "origin" | "project" | "model" | "harness";
export type Unit = "money" | "tokens";
export type Filters = {
  scope: Scope;
  // Harnesses left out; an empty set shows them all.
  hidden: Set<string>;
  colorBy: ColorBy;
  unit: Unit;
  // The one series picked in «De dónde sale», or null.
  focus: string | null;
};

// Series past these share «Otros»: the palette has five validated slots.
export const SLOTS = 5;
export const OTHER = "\0otros";
// Under this many hours the pace is noise, and no projection is drawn.
export const MIN_PROJECTION_HOURS = 6;
const PACE_HOURS = 24;
const HOUR = 3_600_000;

export const amount = (r: PeriodRow, unit: Unit) => (unit === "money" ? (r.cost ?? 0) : r.tokens);

// The series a row belongs to: its ticket or goal, else its project, when colouring by origin.
export function seriesOf(r: PeriodRow, by: ColorBy): string {
  if (by === "origin") return r.ticket ? `t:${r.ticket}` : `p:${r.project}`;
  if (by === "project") return `p:${r.project}`;
  if (by === "model") return `m:${r.model}`;
  return `h:${r.harness}`;
}

export function seriesLabel(key: string, goals: Record<string, string>): string {
  if (key === OTHER) return "Otros";
  const name = key.slice(2);
  if (key.startsWith("t:")) return goals[name] ?? name;
  if (key.startsWith("p:")) return name || "sin carpeta";
  return name;
}

export function filtered(rows: PeriodRow[], f: Filters): PeriodRow[] {
  return rows.filter(
    (r) =>
      !f.hidden.has(r.harness) &&
      (f.scope === "all" || (f.scope === "ticket") === (r.ticket !== "")) &&
      (f.focus === null || seriesOf(r, f.colorBy) === f.focus),
  );
}

const sumBy = (
  rows: PeriodRow[],
  key: (r: PeriodRow) => string,
  value: (r: PeriodRow) => number,
) => {
  const out = new Map<string, number>();
  for (const r of rows) out.set(key(r), (out.get(key(r)) ?? 0) + value(r));
  return out;
};

// The palette slot of each series: the largest of the whole period, by cost then tokens,
// unfiltered, so a filter never repaints a series that stays.
export function slotsOf(rows: PeriodRow[], by: ColorBy): Map<string, number> {
  const cost = sumBy(
    rows,
    (r) => seriesOf(r, by),
    (r) => r.cost ?? 0,
  );
  const tokens = sumBy(
    rows,
    (r) => seriesOf(r, by),
    (r) => r.tokens,
  );
  const ranked = [...tokens.keys()].sort(
    (a, b) =>
      (cost.get(b) ?? 0) - (cost.get(a) ?? 0) || (tokens.get(b) ?? 0) - (tokens.get(a) ?? 0),
  );
  return new Map(ranked.slice(0, SLOTS).map((k, i) => [k, i + 1]));
}

export const colorOf = (key: string, slots: Map<string, number>, by: ColorBy) => {
  if (by === "harness" && key !== OTHER) return `var(--h-${key.slice(2)}, var(--cat-other))`;
  const slot = slots.get(key);
  return slot ? `var(--cat-${slot})` : "var(--cat-other)";
};

export type Series = { key: string; total: number; cum: number[] };

// The running total of each shown series, hour by hour: the slotted ones by size, «Otros» last.
export function stackOf(
  rows: PeriodRow[],
  hours: number,
  f: Filters,
  slots: Map<string, number>,
): Series[] {
  const per = new Map<string, number[]>();
  for (const r of rows) {
    const s = seriesOf(r, f.colorBy);
    const key = slots.has(s) || f.colorBy === "harness" ? s : OTHER;
    let values = per.get(key);
    if (!values) {
      values = Array(hours).fill(0);
      per.set(key, values);
    }
    values[r.h] = (values[r.h] ?? 0) + amount(r, f.unit);
  }
  const series = [...per].map(([key, values]) => {
    let run = 0;
    const cum = values.map((v) => (run += v));
    return { key, total: run, cum };
  });
  return series
    .filter((s) => s.total > 0)
    .sort((a, b) => Number(a.key === OTHER) - Number(b.key === OTHER) || b.total - a.total);
}

// The running total of every row, hour by hour.
export function cumulative(rows: PeriodRow[], hours: number, unit: Unit): number[] {
  const values = Array(hours).fill(0) as number[];
  for (const r of rows) values[r.h] = (values[r.h] ?? 0) + amount(r, unit);
  let run = 0;
  return values.map((v) => (run += v));
}

// The hour of the week, local, Monday 00:00 first: what a normal hour is matched on.
const slotOf = (ms: number) => {
  const d = new Date(ms);
  return ((d.getDay() + 6) % 7) * 24 + d.getHours();
};
const WEEK_HOURS = 168;
// The weeks before need this many with spend for their shape to say anything.
export const MIN_PROFILE_WEEKS = 2;
// This period against the weeks before, so far: a busier week stays busier. Backtested on the
// closed weeks of sept.-oct. 2026: ×0,25-×4 erred 38 % at a quarter, half and three quarters of
// the week, ×0,5-×2 45 %, the last day's pace 53 %.
const SCALE = [0.25, 4] as const;
// Under this share of a normal week gone by, the comparison so far is noise.
const MIN_SCALE_SHARE = 0.05;

export const filteredHistory = (rows: HistoryRow[], f: Filters) =>
  rows.filter(
    (r) => !f.hidden.has(r.harness) && (f.scope === "all" || (f.scope === "ticket") === r.ticketed),
  );

// Each week before, as what every hour of the week cost; only the weeks that spent.
function weeksOf(
  history: NonNullable<UsagePeriod["history"]>,
  rows: HistoryRow[],
  unit: Unit,
): number[][] {
  const t0 = Date.parse(history.start);
  const weeks = Array.from({ length: history.weeks }, () => Array(WEEK_HOURS).fill(0) as number[]);
  for (const r of rows) {
    const week = weeks[Math.floor(r.h / WEEK_HOURS)];
    const slot = slotOf(t0 + r.h * HOUR);
    if (week) week[slot] = (week[slot] ?? 0) + (unit === "money" ? (r.cost ?? 0) : r.tokens);
  }
  return weeks.filter((w) => w.some((v) => v > 0));
}

export type Pace = {
  spent: number;
  // The amount spent at the same point of the period before; null with nothing to compare.
  before: number | null;
  perHour: number | null;
  // What the same 24 hours of the week cost on average in the weeks before.
  normalDay: number | null;
  // Where the period ends; null when closed, focused on one series or too young to say.
  projected: number | null;
  // How: the shape of the weeks before, or the last day's pace when there are too few.
  basis: "profile" | "pace";
  weeks: number;
  // The running total from now to the end: the average week's, and the lowest and highest
  // week before carried the same way. Empty when there is no projection.
  path: { mid: number[]; low: number[]; high: number[] };
};

const EMPTY_PATH = { mid: [], low: [], high: [] };

export function paceOf(
  p: UsagePeriod,
  cum: number[],
  previous: number[],
  history: HistoryRow[] | null = null,
  unit: Unit = "money",
): Pace {
  const at = Math.max(0, p.elapsed - 1);
  const spent = p.elapsed > 0 ? (cum[at] ?? 0) : 0;
  const window = Math.min(PACE_HOURS, p.elapsed);
  const start = cum[at - window] ?? 0;
  const perHour = window > 0 ? (spent - start) / window : null;
  const open = p.elapsed < p.hours;
  const before = previous.length ? (previous[Math.min(at, previous.length - 1)] ?? 0) : null;
  const base = { spent, before: before || null, perHour, normalDay: null, weeks: 0 };
  const t0 = Date.parse(p.start);
  const slotAt = (k: number) => slotOf(t0 + k * HOUR);
  const weeks = p.history && history ? weeksOf(p.history, history, unit) : [];
  if (open && weeks.length >= MIN_PROFILE_WEEKS) {
    const mean = (slot: number) => weeks.reduce((n, w) => n + (w[slot] ?? 0), 0) / weeks.length;
    let expected = 0;
    let whole = 0;
    let normalDay = 0;
    for (let k = 0; k < p.hours; k++) {
      const m = mean(slotAt(k));
      whole += m;
      if (k < p.elapsed) expected += m;
      if (k < p.elapsed && k >= p.elapsed - window) normalDay += m;
    }
    const scale =
      expected >= whole * MIN_SCALE_SHARE
        ? Math.min(SCALE[1], Math.max(SCALE[0], spent / expected))
        : 1;
    const carry = (cost: (slot: number) => number) => {
      let run = spent;
      const out: number[] = [];
      for (let k = p.elapsed; k < p.hours; k++) {
        run += cost(slotAt(k)) * scale;
        out.push(run);
      }
      return out;
    };
    const mid = carry(mean);
    const each = weeks.map((w) => carry((slot) => w[slot] ?? 0));
    const low = mid.map((_, i) => Math.min(...each.map((c) => c[i] ?? 0)));
    const high = mid.map((_, i) => Math.max(...each.map((c) => c[i] ?? 0)));
    return {
      ...base,
      normalDay: window > 0 ? normalDay : null,
      projected: mid.at(-1) ?? spent,
      basis: "profile",
      weeks: weeks.length,
      path: { mid, low, high },
    };
  }
  const projected =
    open && perHour !== null && p.elapsed >= MIN_PROJECTION_HOURS
      ? spent + perHour * (p.hours - p.elapsed)
      : null;
  const mid =
    projected === null || perHour === null
      ? []
      : Array.from({ length: p.hours - p.elapsed }, (_, i) => spent + perHour * (i + 1));
  return {
    ...base,
    projected,
    basis: "pace",
    path: projected === null ? EMPTY_PATH : { mid, low: mid, high: mid },
  };
}

// Local weekday (Monday first) by hour of the day, for «Cuándo gastas».
export function heatOf(rows: PeriodRow[], start: string, unit: Unit): number[][] {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const t0 = Date.parse(start);
  for (const r of rows) {
    const d = new Date(t0 + r.h * 3_600_000);
    const day = grid[(d.getDay() + 6) % 7];
    if (day) day[d.getHours()] = (day[d.getHours()] ?? 0) + amount(r, unit);
  }
  return grid;
}

// Totals of one dimension, largest first.
export function totalsBy(rows: PeriodRow[], key: (r: PeriodRow) => string, unit: Unit) {
  return [...sumBy(rows, key, (r) => amount(r, unit))]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
}

// Tokens of models with no price: in money they are left out, and the page says how many.
export const unpricedTokens = (rows: PeriodRow[]) =>
  rows.reduce((n, r) => n + (r.cost === null ? r.tokens : 0), 0);
