import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { cleanEnv } from "../terminals/env.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { type Proc, parseLstart, psProcs, RECENT_MS, scanSessions } from "./scan.ts";

const NOW = Date.UTC(2026, 9, 1, 8, 0, 0);
const at = (iso: string) => Date.parse(iso);
let home: string;

// A fake process table: pid → start (ms UTC) and command.
const table = new Map<number, Proc>([
  [101, { start: at("2026-10-01T07:00:00Z"), comm: "claude" }],
  [102, { start: at("2026-10-01T07:30:00Z"), comm: "claude" }], // pid reused by a later process
  [104, { start: at("2026-10-01T06:00:00Z"), comm: "claude" }], // launched by the app
  [201, { start: at("2026-10-01T06:59:58Z"), comm: "/Users/x/.local/bin/grok" }],
  [202, { start: at("2026-10-01T07:00:00Z"), comm: "zsh" }], // reused by another program
  [203, { start: at("2026-10-01T07:50:00Z"), comm: "grok" }], // grok, but started after open
]);
const asked: number[][] = [];
const procs = async (pids: number[]) => {
  asked.push(pids);
  return new Map(pids.flatMap((p) => (table.has(p) ? [[p, table.get(p) as Proc] as const] : [])));
};

const claude = (pid: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid,
    sessionId: `s-${pid}`,
    cwd: `/work/p${pid}`,
    procStart: "Thu Oct  1 07:00:00 2026",
    startedAt: at("2026-10-01T07:00:00Z"),
    updatedAt: at("2026-10-01T07:55:00Z"),
    kind: "interactive",
    status: "busy",
    name: `n${pid}`,
    messagingSocketPath: "/tmp/secret.sock",
    ...extra,
  });

function codexRollout(day: string, name: string, meta: unknown, mtime: number) {
  const d = join(home, ".codex", "sessions", day);
  mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, `${typeof meta === "string" ? meta : JSON.stringify(meta)}\n{"type":"x"}\n`);
  utimesSync(p, mtime / 1000, mtime / 1000);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "aos-sessions-"));
  const s = join(home, ".claude", "sessions");
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, "101.json"), claude(101));
  writeFileSync(join(s, "102.json"), claude(102));
  writeFileSync(join(s, "103.json"), claude(103)); // pid gone
  writeFileSync(join(s, "104.json"), claude(104, { procStart: "Thu Oct  1 06:00:00 2026" }));
  writeFileSync(join(s, "105.json"), "{not json");
  writeFileSync(join(s, "106.json"), JSON.stringify({ pid: 106 })); // wrong shape
  // A key file that must never be read: if the scanner opened it, the parse would count it.
  writeFileSync(join(s, "101.abc.key"), "SECRET");
  writeFileSync(join(s, "notes.json"), claude(101));

  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(
    join(home, ".grok", "active_sessions.json"),
    JSON.stringify(
      [201, 202, 203, 204].map((pid) => ({
        session_id: `g-${pid}`,
        pid,
        cwd: `/work/g${pid}`,
        opened_at: "2026-10-01T09:00:00+02:00",
      })),
    ),
  );

  const meta = (id: string) => ({
    type: "session_meta",
    payload: {
      id,
      cwd: `/work/${id}`,
      timestamp: "2026-10-01T07:40:00Z",
      originator: "codex-tui",
      base_instructions: "x".repeat(200_000),
    },
  });
  codexRollout("2026/10/01", "rollout-a.jsonl", meta("c-recent"), NOW - 60_000);
  codexRollout("2026/10/01", "rollout-b.jsonl", meta("c-quiet"), NOW - RECENT_MS - 60_000);
  codexRollout("2026/09/30", "rollout-c.jsonl", meta("c-yesterday"), NOW - 20 * 3600_000);
  codexRollout("2026/09/30", "rollout-d.jsonl", meta("c-old"), NOW - 30 * 3600_000);
  codexRollout("2026/10/01", "rollout-e.jsonl", "{broken", NOW - 60_000);
  codexRollout("2026/10/01", "rollout-f.jsonl", { type: "turn" }, NOW - 60_000);
  codexRollout("2026/10/01", "other.jsonl", meta("c-other"), NOW - 60_000);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

const scan = (appPids = new Set([104])) => scanSessions({ home, now: NOW, appPids, procs });

describe("external sessions", () => {
  test("lstart parses ps and Claude's procStart the same way, in UTC", () => {
    expect(parseLstart("Thu Oct  1 07:08:43 2026")).toBe(at("2026-10-01T07:08:43Z"));
    expect(parseLstart("Tue Sep 29 11:08:39 2026")).toBe(at("2026-09-29T11:08:39Z"));
    expect(parseLstart("Thu Foo  1 07:08:43 2026")).toBeNull();
    expect(parseLstart("yesterday")).toBeNull();
  });

  test("Claude: activa only for the same live process; ended, app and bad files counted apart", async () => {
    const r = await scan();
    const ids = r.sessions.filter((s) => s.harness === "claude").map((s) => s.id);
    expect(ids).toEqual(["s-101"]);
    const s = r.sessions.find((x) => x.id === "s-101");
    expect(s).toEqual({
      harness: "claude",
      id: "s-101",
      pid: 101,
      cwd: "/work/p101",
      name: "n101",
      kind: "interactive",
      status: "busy",
      state: "activa",
      startedAt: "2026-10-01T07:00:00.000Z",
      updatedAt: "2026-10-01T07:55:00.000Z",
    });
    expect(JSON.stringify(r)).not.toContain("secret.sock");
    // One ps call per harness, with only the pids from the session files (never the key's).
    expect(asked.some((p) => [...p].sort().join() === "101,102,103,104")).toBe(true);
  });

  test("an app terminal's pid is not listed as external", async () => {
    const withApp = await scan(new Set([104]));
    const without = await scan(new Set());
    expect(withApp.sessions.some((s) => s.id === "s-104")).toBe(false);
    expect(without.sessions.some((s) => s.id === "s-104")).toBe(true);
  });

  test("Grok: same grok process that opened it, else ended", async () => {
    const r = await scan();
    const grok = r.sessions.filter((s) => s.harness === "grok");
    expect(grok.map((s) => [s.id, s.state, s.startedAt])).toEqual([
      ["g-201", "activa", "2026-10-01T07:00:00.000Z"],
    ]);
  });

  test("Codex: last 24 h by mtime, reciente vs desconocida, header only", async () => {
    const r = await scan();
    const codex = r.sessions.filter((s) => s.harness === "codex");
    expect(codex.map((s) => [s.id, s.state])).toEqual([
      ["c-recent", "reciente"],
      ["c-quiet", "desconocida"],
      ["c-yesterday", "desconocida"],
    ]);
    expect(codex[0]).toMatchObject({ pid: null, cwd: "/work/c-recent", kind: "codex-tui" });
  });

  test("totals: skipped and ended counted, activa first", async () => {
    const r = await scan();
    // skipped: 105 (bad json), 106 (shape), rollout-e (broken), rollout-f (not a header)
    expect(r.skipped).toBe(4);
    // ended: 102 (reused pid), 103 (gone), 202 (not grok), 203 (started later), 204 (gone)
    expect(r.ended).toBe(5);
    expect(r.missing).toEqual([]);
    expect(r.sessions.map((s) => s.state)).toEqual([
      "activa",
      "activa",
      "reciente",
      "desconocida",
      "desconocida",
    ]);
  });

  test("a long Codex session in an older day dir is found; an out-of-range date never throws", async () => {
    const other = mkdtempSync(join(tmpdir(), "aos-edge-"));
    const prev = home;
    home = other;
    try {
      const meta = (id: string) => ({
        type: "session_meta",
        payload: { id, cwd: `/work/${id}`, timestamp: "2026-09-28T07:40:00Z" },
      });
      // Started three days ago, still writing: the dir is old, the mtime is not.
      codexRollout("2026/09/28", "rollout-long.jsonl", meta("c-long"), NOW - 60_000);
      // Past the scanned week: documented as missed.
      codexRollout("2026/09/20", "rollout-ancient.jsonl", meta("c-ancient"), NOW - 60_000);
      const s = join(other, ".claude", "sessions");
      mkdirSync(s, { recursive: true });
      writeFileSync(join(s, "101.json"), claude(101, { startedAt: 1e20, updatedAt: -1e20 }));
      const r = await scanSessions({ home: other, now: NOW, appPids: new Set(), procs });
      expect(r.sessions.filter((x) => x.harness === "codex").map((x) => x.id)).toEqual(["c-long"]);
      expect(r.sessions.find((x) => x.id === "s-101")).toMatchObject({
        state: "activa",
        startedAt: null,
        updatedAt: null,
      });
    } finally {
      home = prev;
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a harness without a store is missing, not an error", async () => {
    const empty = mkdtempSync(join(tmpdir(), "aos-empty-"));
    try {
      const r = await scanSessions({ home: empty, now: NOW, appPids: new Set(), procs });
      expect(r).toEqual({
        sessions: [],
        skipped: 0,
        ended: 0,
        missing: ["claude", "codex", "grok"],
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("the real ps reads this process and drops pids that do not exist", async () => {
    // 2**31 - 1 is past every PID_MAX: on its own it would make macOS ps fail the whole call.
    const r = await psProcs([process.pid, 99_998, 2 ** 31 - 1]);
    const me = r.get(process.pid);
    expect(me?.comm).toContain("bun");
    expect(Math.abs((me?.start ?? 0) - (Date.now() - performance.now()))).toBeLessThan(5_000);
    expect(r.size).toBe(1);
  });

  test("the scan feeds the agents; it has no route of its own", async () => {
    const config = ConfigSchema.parse({});
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () =>
      Promise.resolve(cleanEnv({ PATH: "/usr/bin" }, {})),
    );
    const app = createApp({ config, db, terminals, tokens: new AttachTokens() });
    const host = `127.0.0.1:${config.port}`;
    expect((await app.request("/api/sessions", { headers: { host } })).status).toBe(404);
    await terminals.stopAll(200);
  });
});
