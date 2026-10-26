import { describe, expect, test } from "bun:test";
import type { ProcRow } from "../monitor/monitor.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { KeepAwake } from "./keep-awake.ts";
import { systemSnapshot } from "./system.ts";

const row = (pid: number, ppid: number, cpu: number, rssKb: number): ProcRow => ({
  pid,
  ppid,
  cpu,
  rssKb,
});

const term = (id: string, state: TerminalInfo["state"], pid: number | null) =>
  ({ id, state, pid }) as TerminalInfo;

const PLANS = {
  claude: {
    windows: [
      { minutes: 300, percent: 8, resetAt: null },
      { minutes: 10_080, percent: 29, resetAt: null },
    ],
    updatedAt: "2026-10-06T14:00:00.000Z",
  },
  codex: {
    windows: [{ minutes: 10_080, percent: 13, resetAt: null }],
    updatedAt: "2026-10-06T14:00:00.000Z",
  },
  grok: { error: "no_source" as const },
};

describe("system snapshot", () => {
  test("the server with its helpers, the host alone, and each running terminal's tree", async () => {
    const rows = [
      row(1, 0, 0, 0),
      // The server and its caffeinate.
      row(100, 1, 2.5, 200_000),
      row(101, 100, 0, 1_000),
      // The PTY host, its two shells, and an agent below one of them.
      row(200, 1, 1.0, 80_000),
      row(300, 200, 0.5, 4_000),
      row(301, 300, 30, 400_000),
      row(310, 200, 0, 3_000),
    ];
    const awake = new KeepAwake({ spawn: () => ({ kill: () => {} }), pid: 100 });
    awake.sync(true);
    const terminals = {
      list: () => [
        term("a", "running", 300),
        term("b", "running", 999),
        term("c", "exited", 310),
        term("d", "running", null),
      ],
    } as unknown as Terminals;
    const snap = await systemSnapshot({
      terminals,
      serverPid: 100,
      hostInfo: async () => ({ pid: 200, stale: true }),
      keepAwake: awake,
      ps: async () => rows,
      plans: async () => PLANS,
    });
    expect(snap.app).toEqual({
      server: { cpu: 2.5, rssKb: 201_000 },
      host: { cpu: 1.0, rssKb: 80_000 },
      hostStale: true,
    });
    expect(snap.terminals).toEqual([
      { id: "a", cpu: 30.5, rssKb: 404_000 },
      { id: "b", cpu: null, rssKb: null },
      { id: "d", cpu: null, rssKb: null },
    ]);
    expect(snap.awake.held).toBe(true);
    expect(snap.plans).toEqual(PLANS);
  });

  test("a host the server started is its child, but not part of the server's cost", async () => {
    const rows = [
      row(1, 0, 0, 0),
      row(100, 1, 2.5, 200_000),
      row(200, 100, 1.0, 80_000),
      row(300, 200, 30, 4_000_000),
    ];
    const snap = await systemSnapshot({
      terminals: { list: () => [term("a", "running", 300)] } as unknown as Terminals,
      serverPid: 100,
      hostInfo: async () => ({ pid: 200, stale: false }),
      ps: async () => rows,
      plans: async () => PLANS,
    });
    expect(snap.app.server).toEqual({ cpu: 2.5, rssKb: 200_000 });
    expect(snap.app.host).toEqual({ cpu: 1.0, rssKb: 80_000 });
    expect(snap.terminals).toEqual([{ id: "a", cpu: 30, rssKb: 4_000_000 }]);
  });

  test("an unknown host and no sleep guard read as unknown and released", async () => {
    const snap = await systemSnapshot({
      terminals: { list: () => [] } as unknown as Terminals,
      serverPid: 100,
      ps: async () => [row(100, 1, 0, 10)],
      plans: async () => ({ ...PLANS, claude: { error: "no_source" } }),
    });
    expect(snap.app.host).toBeNull();
    expect(snap.app.hostStale).toBe(false);
    expect(snap.awake).toEqual({ held: false, since: null, screen: null });
    expect(snap.plans.claude).toEqual({ error: "no_source" });
  });
});
