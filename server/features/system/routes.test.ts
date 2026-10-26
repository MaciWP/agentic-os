import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { Terminals } from "../terminals/contract.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { KeepAwake } from "./keep-awake.ts";

const HOST = "127.0.0.1:4317";
const ORIGIN = "http://127.0.0.1:4317";

describe("POST /api/system/awake", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-awake-routes-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const spawned: string[][] = [];
  let killed = 0;
  const keepAwake = new KeepAwake({
    spawn: (argv) => {
      spawned.push(argv);
      return { kill: () => killed++ };
    },
    pid: 9,
    now: () => new Date("2026-10-07T10:00:00Z"),
    timer: () => () => {},
  });
  const app = createApp({
    config: ConfigSchema.parse({ repos: [] }),
    db: openDb(":memory:"),
    terminals: { subscribe: () => () => {}, list: () => [] } as unknown as Terminals,
    tokens: new AttachTokens(),
    memoryRoots: { home: join(root, "home"), dataDir: join(root, "data"), repos: [] },
    pastesDir: join(root, "pastes"),
    keepAwake,
  });
  const post = (body: unknown, origin = ORIGIN) =>
    app.request("/api/system/awake", {
      method: "POST",
      headers: { host: HOST, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("holds the screen for the chosen hours and frees it", async () => {
    const on = await post({ screen: { minutes: 120 } });
    expect(on.status).toBe(200);
    expect((await on.json()).awake.screen).toEqual({
      until: "2026-10-07T12:00:00.000Z",
      auto: false,
    });
    expect(spawned).toEqual([["/usr/bin/caffeinate", "-d", "-i", "-s", "-w", "9"]]);
    const off = await post({ screen: null });
    expect((await off.json()).awake.screen).toBeNull();
    expect(killed).toBe(1);
  });

  test("only 1, 2 or 4 hours or no limit; another site is refused", async () => {
    expect((await post({ screen: { minutes: 30 } })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ screen: { minutes: null } }, "http://evil.example")).status).toBe(403);
    expect(spawned).toHaveLength(1);
  });
});

describe("POST /api/system/restart", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-restart-routes-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const asked: string[] = [];
  let refusal: string | null = null;
  const app = (restart?: unknown) =>
    createApp({
      config: ConfigSchema.parse({ repos: [] }),
      db: openDb(":memory:"),
      terminals: { subscribe: () => () => {}, list: () => [] } as unknown as Terminals,
      tokens: new AttachTokens(),
      memoryRoots: { home: join(root, "home"), dataDir: join(root, "data"), repos: [] },
      pastesDir: join(root, "pastes"),
      restart: restart as never,
    });
  const restarter = {
    start: async (scope: string) => {
      asked.push(scope);
      return refusal;
    },
  };
  const post = (a: ReturnType<typeof app>, body: unknown, origin: string | null = ORIGIN) =>
    a.request("/api/system/restart", {
      method: "POST",
      headers: {
        host: HOST,
        ...(origin ? { origin } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  test("starts the restart and answers 202 with this server's pid", async () => {
    const res = await post(app(restarter), { scope: "all" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ restarting: "all", pid: process.pid });
    expect(asked).toEqual(["all"]);
  });

  test("a refusal says why, and nothing else is asked", async () => {
    refusal = "el servidor no corre bajo el supervisor: nadie lo volvería a arrancar";
    const res = await post(app(restarter), { scope: "server" });
    refusal = null;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "restart_refused",
      detail: "el servidor no corre bajo el supervisor: nadie lo volvería a arrancar",
    });
    expect((await post(app(), { scope: "all" })).status).toBe(409);
  });

  test("a bad scope, or a write from another site, never reaches the restarter", async () => {
    asked.length = 0;
    expect((await post(app(restarter), { scope: "host" })).status).toBe(400);
    expect((await post(app(restarter), { scope: "all" }, "https://evil.example")).status).toBe(403);
    expect(asked).toEqual([]);
  });
});

describe("GET /api/system/logs", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-logs-routes-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const server = join(root, "server.log");
  writeFileSync(server, "a\nb\nc\n");
  const app = createApp({
    config: ConfigSchema.parse({ repos: [] }),
    db: openDb(":memory:"),
    terminals: { subscribe: () => () => {}, list: () => [] } as unknown as Terminals,
    tokens: new AttachTokens(),
    memoryRoots: { home: join(root, "home"), dataDir: join(root, "data"), repos: [] },
    pastesDir: join(root, "pastes"),
    logs: [server],
  });
  const get = (query = "") =>
    app.request(`/api/system/logs${query}`, { headers: { host: HOST, origin: ORIGIN } });

  test("the last lines of each log, as text", async () => {
    const res = await get("?lines=2");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("===== server.log\nb\nc\n");
  });

  test("a line count out of range is refused", async () => {
    expect((await get("?lines=0")).status).toBe(400);
    expect((await get("?lines=abc")).status).toBe(400);
  });
});
