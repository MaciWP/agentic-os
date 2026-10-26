import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PeriodRow, UsagePeriod } from "../../../server/features/usage/types.ts";
import { renderWith } from "../../test-render.tsx";
import { PeriodPanel } from "./period.tsx";
import {
  cumulative,
  type Filters,
  filtered,
  filteredHistory,
  heatOf,
  OTHER,
  paceOf,
  SLOTS,
  slotsOf,
  stackOf,
} from "./period-view.ts";

const row = (over: Partial<PeriodRow>): PeriodRow => ({
  h: 0,
  harness: "claude",
  model: "claude-opus-5-5",
  ticket: "",
  project: "app",
  cost: 1,
  tokens: 100,
  ...over,
});
const base: Filters = {
  scope: "all",
  hidden: new Set(),
  colorBy: "origin",
  unit: "money",
  focus: null,
};
const period = (over: Partial<UsagePeriod> = {}): UsagePeriod => ({
  kind: "week",
  offset: 0,
  anchor: "plan",
  start: "2026-10-09T18:00:00.000Z",
  end: "2026-10-16T18:00:00.000Z",
  now: "2026-10-14T12:00:00.000Z",
  hours: 168,
  elapsed: 114,
  rows: [],
  previous: {
    start: "2026-10-02T18:00:00.000Z",
    end: "2026-10-09T18:00:00.000Z",
    hours: 168,
    rows: [],
  },
  quota: [],
  history: null,
  coverage: null,
  goals: {},
  unpriced: [],
  ...over,
});

describe("period view", () => {
  test("scope, harness and the picked series filter the rows", () => {
    const rows = [
      row({ ticket: "ABC-1" }),
      row({ harness: "codex", cost: null }),
      row({ project: "web" }),
    ];
    expect(filtered(rows, { ...base, scope: "ticket" })).toHaveLength(1);
    expect(filtered(rows, { ...base, scope: "none" })).toHaveLength(2);
    expect(filtered(rows, { ...base, hidden: new Set(["codex"]) })).toHaveLength(2);
    expect(filtered(rows, { ...base, focus: "p:web" })).toEqual(rows.slice(2));
  });

  test("the largest series keep their colour slot under a filter; the rest share «Otros»", () => {
    const rows = Array.from({ length: SLOTS + 2 }, (_, i) =>
      row({ project: `p${i}`, cost: 10 - i }),
    );
    const slots = slotsOf(rows, "origin");
    expect(slots.get("p:p0")).toBe(1);
    expect(slots.has(`p:p${SLOTS}`)).toBe(false);
    // Filtering p0 out repaints nobody: slots come from the whole period.
    const stack = stackOf(rows.slice(1), 168, base, slots);
    expect(stack.map((s) => s.key)).toEqual(["p:p1", "p:p2", "p:p3", "p:p4", OTHER]);
    expect(stack.at(-1)?.total).toBe(10 - SLOTS + (10 - SLOTS - 1));
  });

  test("the pace is the last day's, the projection waits for six hours and a closed period has none", () => {
    const rows = [row({ h: 0, cost: 10 }), row({ h: 100, cost: 24 })];
    const p = period();
    const cum = cumulative(rows, 168, "money");
    const before = cumulative([row({ h: 50, cost: 20 })], 168, "money");
    const pace = paceOf(p, cum, before);
    expect(pace.spent).toBe(34);
    expect(pace.perHour).toBe(1);
    expect(pace.projected).toBe(34 + 54);
    expect(pace.before).toBe(20);
    expect(paceOf(period({ elapsed: 5 }), cum, before).projected).toBeNull();
    expect(paceOf(period({ elapsed: 168 }), cum, before).projected).toBeNull();
    // Nothing before: no comparison, never a zero.
    expect(paceOf(p, cum, []).before).toBeNull();
  });

  describe("in Madrid", () => {
    let tz: string | undefined;
    beforeEach(() => {
      tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      process.env.TZ = "Europe/Madrid";
    });
    afterEach(() => {
      process.env.TZ = tz;
    });

    test("the projection follows the shape of the weeks before: a quiet weekend stays quiet", () => {
      // Monday 12 Oct, 00:00 in Madrid; two weeks before it, each busy on Monday morning and
      // light on Saturday morning.
      const hist = (h: number, cost: number) => ({
        h,
        harness: "claude",
        ticketed: false,
        cost,
        tokens: 0,
      });
      const p = period({
        start: "2026-10-11T22:00:00.000Z",
        end: "2026-10-18T22:00:00.000Z",
        elapsed: 24,
        history: {
          start: "2026-09-27T22:00:00.000Z",
          weeks: 2,
          rows: [hist(10, 10), hist(130, 2), hist(178, 10), hist(298, 4)],
        },
      });
      const cum = cumulative([row({ h: 10, cost: 10 })], 168, "money");
      const pace = paceOf(p, cum, [], p.history?.rows ?? [], "money");
      expect(pace.basis).toBe("profile");
      expect(pace.weeks).toBe(2);
      // The last day's pace would say 10 + 10/24 × 144 = 70.
      expect(pace.projected).toBeCloseTo(13, 9);
      expect(pace.path.low.at(-1)).toBeCloseTo(12, 9);
      expect(pace.path.high.at(-1)).toBeCloseTo(14, 9);
      expect(pace.normalDay).toBeCloseTo(10, 9);
      // One week with spend is too little: back to the last day's pace.
      const thin = paceOf(p, cum, [], [hist(10, 10)], "money");
      expect(thin.basis).toBe("pace");
      expect(thin.projected).toBeCloseTo(70, 9);
      // A ticket scope keeps only the ticketed hours of the weeks before.
      expect(filteredHistory(p.history?.rows ?? [], { ...base, scope: "ticket" })).toEqual([]);
    });

    test("the heat map files each hour under its local weekday and hour", () => {
      // Friday 18:00Z is 20:00 in Madrid; 30 hours on, Sunday 02:00.
      const grid = heatOf(
        [row({ h: 0 }), row({ h: 30, cost: 2 })],
        "2026-10-09T18:00:00.000Z",
        "money",
      );
      expect(grid[4]?.[20]).toBe(1);
      expect(grid[6]?.[2]).toBe(2);
    });
  });
});

describe("period panel", () => {
  test("shows the week's figures, its series and how much of Claude Code's count it holds", async () => {
    const p = period({
      rows: [
        row({ h: 2, ticket: "ABC-1", cost: 30 }),
        row({ h: 3, project: "agentic-os", cost: 60 }),
        row({ h: 4, harness: "codex", model: "gpt-x", cost: null, tokens: 5000 }),
      ],
      previous: { ...period().previous, rows: [row({ h: 1, cost: 45 })] },
      coverage: { sessions: 3, harnessUsd: 100, oursUsd: 97, outsideUsd: 3, late: 1 },
      quota: [
        {
          harness: "claude",
          minutes: 10_080,
          at: "2026-10-12T10:00:00.000Z",
          percent: 30,
          resetAt: "2026-10-16T18:00:00.000Z",
        },
      ],
    });
    const html = await renderWith(
      <PeriodPanel pick={{ kind: "week", offset: 0 }} onPick={() => {}} onTicket={() => {}} />,
      [[["usage-period", "week", 0], p]],
    );
    expect(html).toContain("Semana de cuota");
    expect(html).toContain("90,00");
    expect(html).toContain("sin precio: 5 k tokens");
    // Intl puts a no-break space before the sign.
    expect(html).toMatch(/97\s%/);
    expect(html).toContain("1 con contador tardío");
    expect(html).toContain("agentic-os");
    expect(html).toContain("ABC-1");
    // $90 of Claude against 30 % of the quota.
    expect(html).toContain("3,00");
    expect(html).toContain("Claude 30 % de la cuota");
  });
});
