import { describe, expect, test } from "bun:test";
import { noVerifyIn, type Pr, report, revertedBy } from "./delivery.ts";

const pr = (over: Partial<Pr>): Pr => ({
  repo: "o/r",
  number: 1,
  title: "t",
  ticket: "ABC-1",
  created: "2026-10-05T10:00:00Z",
  merged: null,
  closed: null,
  reviews: 0,
  reviewComments: 0,
  additions: 0,
  deletions: 0,
  reverted: false,
  ...over,
});

const bash = (command: string, over: object = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-05T10:00:00Z",
    gitBranch: "feature/ABC-7",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
    ...over,
  });

describe("revertedBy", () => {
  test("a revert title that quotes the PR or names its number", () => {
    const p = { number: 42, title: "ABC-1: add x" };
    expect(revertedBy(p, ['Revert "ABC-1: add x"'])).toBe(true);
    expect(revertedBy(p, ["Revert #42"])).toBe(true);
    expect(revertedBy(p, ["Revert #420", 'Revert "ABC-1: add y"'])).toBe(false);
    expect(revertedBy(p, ["Fix #42 after review"])).toBe(false);
  });
});

describe("noVerifyIn", () => {
  test("counts each git commit --no-verify in the window, with its branch's ticket", () => {
    expect(noVerifyIn(bash('git commit --no-verify -m "x"'), "2026-10-01", "2026-10-31")).toEqual([
      "ABC-7",
    ]);
    expect(
      noVerifyIn(bash("git commit --no-verify", { gitBranch: "main" }), "2026-10-01", "2026-10-31"),
    ).toEqual([""]);
  });

  test("skips other commands, other tools, user lines and lines out of the window", () => {
    const w = ["2026-10-01", "2026-10-31"] as const;
    expect(noVerifyIn(bash("git push --no-verify"), ...w)).toEqual([]);
    expect(noVerifyIn(bash("git commit -m x"), ...w)).toEqual([]);
    expect(noVerifyIn(bash("git commit --no-verify", { type: "user" }), ...w)).toEqual([]);
    expect(
      noVerifyIn(bash("git commit --no-verify", { timestamp: "2026-09-30T23:00:00Z" }), ...w),
    ).toEqual([]);
    expect(noVerifyIn("not json --no-verify", ...w)).toEqual([]);
  });
});

describe("report", () => {
  const base = { since: "2026-10-01", until: "2026-10-31", errors: [] };
  const prs = [
    pr({ number: 1, merged: "2026-10-06T10:00:00Z", closed: "2026-10-06T10:00:00Z", reviews: 2 }),
    pr({ number: 2, ticket: "ABC-2", created: "2026-10-13T10:00:00Z", reverted: true }),
    pr({
      number: 3,
      ticket: null,
      created: "2026-10-13T12:00:00Z",
      closed: "2026-10-14T00:00:00Z",
      reviewComments: 4,
    }),
  ];
  const usage = {
    total: { cost: 100 },
    byTicket: [
      { key: "ABC-1", cost: 30 },
      { key: "ABC-2", cost: 10 },
    ],
  };

  test("adds up PR states, cycle, reviews, reverts, commits and cost", () => {
    const r = report({ ...base, prs, noVerify: ["ABC-1", ""], usage });
    expect(r.summary).toEqual({
      opened: 3,
      merged: 1,
      open: 1,
      closedUnmerged: 1,
      cycleHours: { median: 24, p90: 24 },
      reviewsPerPr: 0,
      reviewCommentsPerPr: 0,
      reverted: 1,
      noVerify: 1,
      noVerifyOffTicket: 1,
      cost: { total: 100, tickets: 40, outsideTickets: 60, perMergedPr: 30 },
    });
    expect(r.byWeek).toEqual([
      { week: "2026-10-05", opened: 1, merged: 1 },
      { week: "2026-10-12", opened: 2, merged: 0 },
    ]);
    expect(r.byTicket.map((t) => [t.ticket, t.merged, t.cycleHours, t.noVerify, t.cost])).toEqual([
      ["ABC-1", 1, 24, 1, 30],
      ["ABC-2", 0, null, 0, 10],
    ]);
  });

  test("a failed source is null, never zero", () => {
    const r = report({ ...base, prs, noVerify: null, usage: null });
    expect(r.summary.noVerify).toBeNull();
    expect(r.summary.cost).toEqual({
      total: null,
      tickets: null,
      outsideTickets: null,
      perMergedPr: null,
    });
    expect(r.byTicket[0]?.cost).toBeNull();
  });
});
