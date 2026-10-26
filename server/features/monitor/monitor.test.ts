import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { Proc } from "../sessions/scan.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import {
  agentsSnapshot,
  LAST_LINE_CHARS,
  lastLine,
  type ProcRow,
  parsePs,
  psTree,
  treeUsage,
  winRows,
} from "./monitor.ts";
import { agentRoutes } from "./routes.ts";

const row = (pid: number, ppid: number, cpu: number, rssKb: number): ProcRow => ({
  pid,
  ppid,
  cpu,
  rssKb,
});

describe("process usage", () => {
  test("ps rows parse; anything else is skipped", () => {
    expect(parsePs("  PID  PPID\n  12     1  3.5  2048\n7 1 0.0 16\nbad line\n")).toEqual([
      row(12, 1, 3.5, 2048),
      row(7, 1, 0, 16),
    ]);
  });

  test("a root counts every process below it and nothing beside it", () => {
    const rows = [
      row(0, 0, 0, 0),
      row(1, 0, 0.5, 100),
      row(10, 1, 1.25, 1000),
      row(11, 10, 2.5, 500),
      row(12, 11, 0.1, 50),
      row(20, 1, 9, 9000),
    ];
    const usage = treeUsage(rows, [10, 20, 99]);
    expect(usage.get(10)).toEqual({ cpu: 3.9, rssKb: 1550 });
    expect(usage.get(20)).toEqual({ cpu: 9, rssKb: 9000 });
    // A root ps did not list is gone.
    expect(usage.has(99)).toBe(false);
    // The pid 0 row is its own parent: no loop.
    expect(treeUsage(rows, [0]).get(0)?.rssKb).toBe(10650);
  });

  test("a root below another root is counted once, as itself", () => {
    const rows = [row(1, 0, 0, 0), row(10, 1, 1, 1000), row(11, 10, 2, 500), row(12, 11, 4, 50)];
    const usage = treeUsage(rows, [10, 11]);
    expect(usage.get(10)).toEqual({ cpu: 1, rssKb: 1000 });
    expect(usage.get(11)).toEqual({ cpu: 6, rssKb: 550 });
  });

  test("the real ps lists this process under its parent", async () => {
    const rows = await psTree();
    const me = rows.find((r) => r.pid === process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.rssKb).toBeGreaterThan(0);
  });

  test("Windows rows take the CPU % of one core from the ticks since the last read", () => {
    // pid ppid ticks(100 ns) workingSetKb; pid 0 is the idle process.
    const first = winRows("0 0 99999999 8\r\n4 0 500 100\r\n40 4 1000 2048\r\n", 1_000);
    expect(first.rows).toEqual([row(4, 0, 0, 100), row(40, 4, 0, 2048)]);
    // One second later: pid 40 spent half a second, pid 41 is new.
    const next = winRows("4 0 500 100\r\n40 4 5001000 2048\r\n41 40 70 10\r\n", 2_000, first.ticks);
    expect(next.rows).toEqual([row(4, 0, 0, 100), row(40, 4, 50, 2048), row(41, 40, 0, 10)]);
  });

  test("the last line is the last one with something on it, capped", () => {
    expect(lastLine("$ ls\nREADME.md\n  \n\n")).toBe("README.md");
    expect(lastLine("\n \n")).toBeNull();
    const long = lastLine("x".repeat(500)) ?? "";
    expect(long).toHaveLength(LAST_LINE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});

const info = (over: Partial<TerminalInfo>): TerminalInfo => ({
  id: "t",
  harness: "shell",
  location: "app",
  cwd: "/work",
  ticket: null,
  name: null,
  env: null,
  action: null,
  state: "running",
  exitCode: null,
  signal: null,
  error: null,
  overflowed: false,
  attached: false,
  activity: "idle",
  lastOutputAt: null,
  pid: null,
  startedAt: "2026-10-02T10:00:00Z",
  endedAt: null,
  ...over,
});

// Only what the monitor calls (the list and a read) and what the app subscribes to.
function fakeTerminals(list: TerminalInfo[], screens: Record<string, string>) {
  const reads: string[] = [];
  const terminals = {
    subscribe: () => () => {},
    list: () => list,
    read: (id: string) => {
      reads.push(id);
      return { text: screens[id] ?? "", seq: 1, state: "running" as const };
    },
  } as unknown as Terminals;
  return { terminals, reads };
}

describe("agents snapshot", () => {
  let home: string;
  const START = "Fri Oct  2 10:00:00 2026";
  const procs = async (pids: number[]) =>
    new Map(
      pids.map((p) => [p, { start: Date.UTC(2026, 9, 2, 10), comm: "claude" } as Proc] as const),
    );
  const session = (pid: number, status: string) =>
    JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: "/work", procStart: START, status });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "aos-monitor-"));
    const dir = join(home, ".claude", "sessions");
    mkdirSync(dir, { recursive: true });
    // 501 is a Claude the app started; 601 runs outside it.
    writeFileSync(join(dir, "501.json"), session(501, "waiting"));
    writeFileSync(join(dir, "601.json"), session(601, "busy"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const ps = async () => [
    row(1, 0, 0, 0),
    row(400, 1, 0.5, 2000),
    row(401, 400, 40, 3000),
    row(501, 1, 12, 300_000),
    row(502, 501, 3, 20_000),
    row(601, 1, 1, 1000),
  ];

  test("app terminals get usage, a shell's last line and Claude's own status", async () => {
    const { terminals, reads } = fakeTerminals(
      [
        info({ id: "sh", pid: 400, lastOutputAt: "2026-10-02T10:05:00Z" }),
        info({ id: "cl", harness: "claude", pid: 501 }),
        info({ id: "gone", harness: "grok", state: "exited", pid: null }),
      ],
      { sh: "$ make\nbuilding 3/9\n", cl: "⏸ plan mode on" },
    );
    const snap = await agentsSnapshot({ terminals, sessions: { home, procs }, ps });
    expect(snap.app).toEqual([
      {
        id: "sh",
        cpu: 40.5,
        rssKb: 5000,
        lastLine: "building 3/9",
        status: null,
        lastOutputAt: "2026-10-02T10:05:00Z",
      },
      { id: "cl", cpu: 15, rssKb: 320_000, lastLine: null, status: "waiting", lastOutputAt: null },
      { id: "gone", cpu: null, rssKb: null, lastLine: null, status: null, lastOutputAt: null },
    ]);
    // An agent's screen is never read: its last rows are its own chrome.
    expect(reads).toEqual(["sh"]);
  });

  test("sessions outside the app are listed with their usage; the app's own are not", async () => {
    const { terminals } = fakeTerminals([info({ id: "cl", harness: "claude", pid: 501 })], {});
    const snap = await agentsSnapshot({ terminals, sessions: { home, procs }, ps });
    expect(snap.outside.map((s) => [s.id, s.status, s.cpu, s.rssKb])).toEqual([
      ["s-601", "busy", 1, 1000],
    ]);
    expect(snap.missing).toEqual(["codex", "grok"]);
  });

  test("GET /api/agents sits behind the local guard", async () => {
    const config = ConfigSchema.parse({});
    const { terminals } = fakeTerminals([info({ id: "sh", pid: 400 })], { sh: "ok\n" });
    const deps = { config, db: openDb(":memory:"), terminals, tokens: new AttachTokens() };
    const app = createApp({ ...deps, sessions: { home, procs } });
    const bad = await app.request("/api/agents", { headers: { host: "evil.test" } });
    expect(bad.status).toBe(403);
    const ok = await app.request("/api/agents", { headers: { host: `127.0.0.1:${config.port}` } });
    expect(ok.status).toBe(200);
    const direct = await agentRoutes(deps, { home, procs }, ps).request("/");
    expect(((await direct.json()) as { app: unknown[] }).app).toEqual([
      { id: "sh", cpu: 40.5, rssKb: 5000, lastLine: "ok", status: null, lastOutputAt: null },
    ]);
  });
});
