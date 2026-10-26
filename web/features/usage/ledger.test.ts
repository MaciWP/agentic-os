import { describe, expect, test } from "bun:test";
import { daysFrom } from "../../../shared/days.ts";
import {
  ALL,
  bucketsOf,
  DAYS_SHOWN,
  deltaOf,
  overviewOf,
  sumBuckets,
  ticketsOf,
  unitOf,
} from "./ledger.ts";
import type { TicketUsage, UsageLine, UsageReport } from "./queries.ts";

const line = (key: string, cost: number | null, tokens = 1_000): UsageLine => ({
  key,
  calls: 10,
  tokens: { input: 0, cacheRead: tokens / 2, cacheWrite: 0, output: tokens / 2 },
  cost,
  unpricedTokens: 0,
  longCalls: 0,
  saved: cost === null ? null : cost / 10,
});

const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const usage = (cost: number[], tokens = cost.map((x) => x * 100)): TicketUsage => ({
  models: [],
  skills: [],
  subagents: [],
  harnesses: [line("claude", 1), line("codex", 3)],
  sessions: [],
  sessionCount: 0,
  first: null,
  last: null,
  activeHours: 0,
  daily: { cost, tokens },
});

const report = (byTicket: UsageLine[], over: Partial<UsageReport> = {}): UsageReport => {
  const cost = byTicket.every((l) => l.cost === null)
    ? null
    : byTicket.reduce((n, l) => n + (l.cost ?? 0), 0);
  return {
    from: DAYS[0] ?? "",
    to: DAYS.at(-1) ?? "",
    firstDay: DAYS[0] ?? null,
    goals: {},
    days: DAYS,
    total: {
      ...line(
        "",
        cost,
        byTicket.reduce((n, l) => n + l.tokens.cacheRead * 2, 0),
      ),
      calls: byTicket.reduce((n, l) => n + l.calls, 0),
    },
    byTicket,
    byLocation: [],
    byModel: [],
    bySkill: [],
    bySubagent: [],
    byRole: [],
    bySession: [],
    events: { skills: [], commands: [], subagents: [], tools: [], mcp: [], hooks: [] },
    tickets: { [ALL]: usage([2, 0, 0, 6]), "ACME-1": usage([1, 0, 0, 3]), "": usage([1, 0, 0, 3]) },
    previous: {
      from: "2026-09-27",
      to: "2026-09-30",
      total: line("", 4),
      byTicket: [line("ACME-1", 2)],
    },
    byModelRole: [],
    repriced: {},
    router: null,
    logPose: null,
    byEffort: [],
    advisorSessions: 0,
    claudeSessions: 0,
    unpriced: [],
    ingest: { lastRunAt: null, ms: null, files: 0, errors: [] },
    ...over,
  };
};

describe("ticketsOf", () => {
  test("all tickets first, then biggest first, and the work with no ticket last", () => {
    const r = report([line("", 50), line("ACME-2", 1), line("ACME-1", 4)]);
    expect(ticketsOf(r, null).map((t) => t.key)).toEqual([ALL, "ACME-1", "ACME-2", ""]);
  });

  test("reads every ticket against the days before; a ticket absent then is new", () => {
    const [all, acme1, acme2] = ticketsOf(report([line("ACME-1", 4), line("ACME-2", 1)]), null);
    expect(all?.delta).toEqual({ kind: "pct", value: 0.25 });
    expect(acme1?.delta).toEqual({ kind: "pct", value: 1 });
    expect(acme2?.delta).toEqual({ kind: "new" });
  });

  test("the whole history has nothing to compare with", () => {
    const tickets = ticketsOf(report([line("ACME-1", 4)], { previous: null }), null);
    expect(tickets.map((t) => t.delta)).toEqual([null, null]);
  });

  test("keeps a 404 as null and leaves the rows Jira was never asked about undefined", () => {
    const [all, acme1, none] = ticketsOf(report([line("ACME-1", 4), line("", 1)]), {
      "ACME-1": null,
    });
    expect([all?.jira, acme1?.jira, none?.jira]).toEqual([undefined, null, undefined]);
  });

  test("a goal row carries its title and is never looked up in Jira", () => {
    const [, goal, ticket] = ticketsOf(
      report([line("goal:7", 4), line("ACME-1", 1)], { goals: { "goal:7": "Refactor the host" } }),
      { "ACME-1": null },
    );
    expect([goal?.key, goal?.goal, goal?.jira]).toEqual(["goal:7", "Refactor the host", undefined]);
    expect([ticket?.goal, ticket?.jira]).toEqual([undefined, null]);
  });

  test("an empty range has no rows at all, not an empty all-tickets row", () => {
    expect(ticketsOf(report([]), null)).toEqual([]);
  });

  test("splits by harness, biggest first, and counts tokens with no prices", () => {
    const [all] = ticketsOf(report([line("ACME-1", null)]), null);
    expect(all?.amount).toBe(1_000);
    expect(all?.daily).toEqual([200, 0, 0, 600]);
    expect(all?.byHarness.map(([h]) => h)).toEqual(["claude", "codex"]);
  });
});

describe("overviewOf", () => {
  test("averages over active days and calendar days, and projects the month", () => {
    const o = overviewOf(report([line("ACME-1", 6), line("", 2)]), new Date(2026, 9, 5).getTime());
    expect(o.unit).toBe("money");
    expect(o.activeDays).toBe(2);
    expect(o.perActiveDay).toBe(4);
    expect(o.perDay).toBe(2);
    expect(o.month).toBe(62);
    expect(o.noTicket).toBe(0.25);
    expect(o.saved).toBe(0.8);
    expect(o.cacheShare).toBe(0.5);
  });

  test("reads an empty range as money, not as unpriced", () => {
    expect(unitOf(report([]))).toBe("money");
    expect(unitOf(report([line("ACME-1", null)]))).toBe("tokens");
  });
});

describe("buckets", () => {
  test("a day per bar up to three months, a week per bar past that", () => {
    const short = daysFrom("2026-07-01", "2026-09-30");
    expect(short.length).toBeLessThanOrEqual(DAYS_SHOWN);
    expect(bucketsOf(short)).toHaveLength(short.length);
    // 2026-01-01 is a Thursday: the first week holds four days, each later one seven at most.
    const year = daysFrom("2026-01-01", "2026-10-06");
    const weeks = bucketsOf(year);
    expect(weeks[0]).toEqual({ day: "2026-01-01", from: 0, days: 4 });
    expect(weeks.every((b) => b.days <= 7)).toBe(true);
    expect(weeks.reduce((n, b) => n + b.days, 0)).toBe(year.length);
    const values = year.map(() => 1);
    expect(sumBuckets(values, weeks).reduce((a, b) => a + b, 0)).toBe(year.length);
  });

  test("compares with the previous period without dividing by zero", () => {
    expect(deltaOf(150, 100)).toEqual({ kind: "pct", value: 0.5 });
    expect(deltaOf(10, 0)).toEqual({ kind: "new" });
    expect(deltaOf(0, 0)).toBeNull();
    expect(deltaOf(10, null)).toBeNull();
  });
});
