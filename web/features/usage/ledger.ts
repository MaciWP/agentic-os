import type { JiraBrief } from "../../../server/features/usage/briefs.ts";
import { weekOf } from "../../../shared/days.ts";
import { ISSUE_KEY } from "../../../shared/envs.ts";
import { type TicketUsage, totalTokens, type UsageLine, type UsageReport } from "./queries.ts";

// Consumo read by ticket: what each ticket cost against the days before the range, where it
// went and when. Every figure is in money when the report has prices and in tokens when it has
// none, so nothing reads as zero or NaN for lack of a price.

export type Unit = "money" | "tokens";

// A change against the previous period: a ratio, "new" when there was nothing before, or null
// when there is no previous period to compare with.
export type Delta = { kind: "pct"; value: number } | { kind: "new" } | null;

// The row that stands for every ticket at once, and the report's key for it.
export const ALL = "*";

export type TicketCost = {
  // ALL, a ticket key, a goal key (goal:<id>), or "" for the work with no ticket.
  key: string;
  // The goal's title when the key is a goal.
  goal?: string;
  amount: number;
  line: UsageLine;
  // undefined: not asked or Jira unavailable; null: Jira does not know the key.
  jira: JiraBrief | null | undefined;
  delta: Delta;
  usage: TicketUsage;
  // The amount of each day of the range, oldest first.
  daily: number[];
  // Amount by harness, biggest first.
  byHarness: [string, number][];
};

export type Overview = {
  unit: Unit;
  amount: number;
  delta: Delta;
  daily: number[];
  // Days with at least one call, and the average over them and over every day of the range.
  activeDays: number;
  perActiveDay: number;
  perDay: number;
  // At the pace of the whole range, over the current month.
  month: number;
  saved: number | null;
  cacheShare: number;
  noTicket: number;
};

// Tokens only when there were calls and none had a price: an empty range is not "unpriced".
export const unitOf = (r: UsageReport): Unit =>
  r.total.cost === null && r.total.calls > 0 ? "tokens" : "money";

export const amountOf = (l: UsageLine, unit: Unit) =>
  unit === "money" ? (l.cost ?? 0) : totalTokens(l);

export const dailyOf = (u: TicketUsage, unit: Unit) =>
  unit === "money" ? u.daily.cost : u.daily.tokens;

export function deltaOf(now: number, before: number | null): Delta {
  if (before === null) return null;
  if (before <= 0) return now > 0 ? { kind: "new" } : null;
  return { kind: "pct", value: now / before - 1 };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const daysInMonth = (now: number) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

const noUsage = (days: number): TicketUsage => ({
  models: [],
  skills: [],
  subagents: [],
  harnesses: [],
  sessions: [],
  sessionCount: 0,
  first: null,
  last: null,
  activeHours: 0,
  daily: { cost: Array(days).fill(0), tokens: Array(days).fill(0) },
});

export const usageOf = (r: UsageReport, key: string) => r.tickets[key] ?? noUsage(r.days.length);

export function overviewOf(r: UsageReport, now: number): Overview {
  const unit = unitOf(r);
  const amount = amountOf(r.total, unit);
  const daily = dailyOf(usageOf(r, ALL), unit);
  const activeDays = daily.filter((x) => x > 0).length;
  const perDay = amount / Math.max(1, r.days.length);
  const all = totalTokens(r.total);
  const none = r.byTicket.find((l) => !l.key);
  return {
    unit,
    amount,
    delta: r.previous ? deltaOf(amount, amountOf(r.previous.total, unit)) : null,
    daily,
    activeDays,
    perActiveDay: amount / Math.max(1, activeDays),
    perDay,
    month: perDay * daysInMonth(now),
    saved: unit === "money" ? r.total.saved : null,
    cacheShare: all > 0 ? r.total.tokens.cacheRead / all : 0,
    noTicket: none && amount > 0 ? amountOf(none, unit) / amount : 0,
  };
}

// Every ticket of the report: all of them first, then biggest first, and the work that names
// no ticket always last.
export function ticketsOf(
  r: UsageReport,
  briefs: Record<string, JiraBrief | null> | null,
): TicketCost[] {
  const unit = unitOf(r);
  const before = new Map(r.previous?.byTicket.map((l) => [l.key, amountOf(l, unit)]));
  const cost = (line: UsageLine, key: string, prev: number | null): TicketCost => {
    const usage = usageOf(r, key);
    // A harness with no priced model splits by tokens rather than leave the strip empty.
    const by: Unit = usage.harnesses.some((l) => amountOf(l, unit) > 0) ? unit : "tokens";
    const amount = amountOf(line, unit);
    return {
      key,
      amount,
      line,
      goal: r.goals[key],
      jira: ISSUE_KEY.test(key) ? briefs?.[key] : undefined,
      delta: r.previous ? deltaOf(amount, prev) : null,
      usage,
      daily: dailyOf(usage, unit),
      byHarness: usage.harnesses
        .map((l): [string, number] => [l.key, amountOf(l, by)])
        .sort((a, b) => b[1] - a[1]),
    };
  };
  const tickets = r.byTicket
    .map((line) => cost(line, line.key, before.get(line.key) ?? 0))
    .sort((a, b) => (!a.key ? 1 : !b.key ? -1 : b.amount - a.amount));
  const prevAll = r.previous ? amountOf(r.previous.total, unit) : null;
  return r.total.calls > 0 ? [cost(r.total, ALL, prevAll), ...tickets] : [];
}

// A long range reads by week: one bar a day stops being readable past three months.
export const DAYS_SHOWN = 92;

// A stretch of the range's days drawn as one bar: `from` is its first day's index.
export type Bucket = { day: string; from: number; days: number };

export function bucketsOf(days: string[]): Bucket[] {
  if (days.length <= DAYS_SHOWN) return days.map((day, from) => ({ day, from, days: 1 }));
  const out: Bucket[] = [];
  days.forEach((day, i) => {
    const last = out.at(-1);
    if (last && weekOf(last.day) === weekOf(day)) last.days++;
    else out.push({ day, from: i, days: 1 });
  });
  return out;
}

export const sumBuckets = (values: number[], buckets: Bucket[]) =>
  buckets.map((b) => sum(values.slice(b.from, b.from + b.days)));
