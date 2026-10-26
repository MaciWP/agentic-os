import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type Health, PROTOCOL } from "../../shared/host-contract.ts";
import { ConfigSchema } from "../config.ts";
import { openDb } from "../db.ts";
import { cleanEnv } from "../features/terminals/env.ts";
import { LaunchError } from "../features/terminals/harness.ts";
import { HostClient } from "../features/terminals/host-client.ts";
import { MAX_RESUMES, markLost, STABLE_MS } from "../features/terminals/lost.ts";
import { type Client, MAX_CLIENT_BUFFER, TerminalManager } from "../features/terminals/pty.ts";
import { importGraph } from "../import-graph.ts";
import { until } from "../test-wait.ts";
import { createHostApp } from "./app.ts";
import { hostPaths, readHostFile, writeHostFile } from "./files.ts";
import { idleWatch, liveConfig } from "./host.ts";
import { connectHost, health, hostBuild, verdict } from "./launch.ts";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const shellEnv = () => Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {}));
const tmp = () => mkdtempSync(join(tmpdir(), "aos-host-"));

// A window as the server sees it; `buffered` stands in for the browser socket's backlog.
const fake = () => {
  const got: (string | Uint8Array)[] = [];
  const state = { closed: 0, buffered: 0 };
  const client: Client = {
    send: (d) => got.push(d),
    close: (code) => {
      state.closed = code;
    },
    bufferedAmount: () => state.buffered,
    isOpen: () => state.closed === 0,
  };
  const out = () => got.map((d) => (typeof d === "string" ? d : text(d))).join("");
  return { client, got, state, out };
};

describe("PTY host files and helpers", () => {
  test("the host file is written whole with mode 0600", () => {
    const dir = tmp();
    const { file } = hostPaths(dir);
    writeHostFile(file, { port: 1234, token: "t".repeat(43), pid: 1, protocol: PROTOCOL });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readHostFile(file)?.port).toBe(1234);
    writeFileSync(file, "{not json");
    expect(readHostFile(file)).toBeUndefined();
    rmSync(dir, { recursive: true });
  });

  test("config edits reach the next launch, and a broken edit fails it", () => {
    const dir = tmp();
    const path = join(dir, "config.json");
    const write = (body: string, at: number) => {
      writeFileSync(path, body);
      utimesSync(path, at, at);
    };
    write(JSON.stringify({ terminals: { shell: "/bin/sh", bins: { claude: "/bin/sh" } } }), 1000);
    const config = liveConfig(path);
    expect(config().terminals.bins.claude).toBe("/bin/sh");
    write(JSON.stringify({ terminals: { shell: "/bin/sh", bins: { claude: "/bin/ls" } } }), 2000);
    expect(config().terminals.bins.claude).toBe("/bin/ls");
    write("{broken", 3000);
    expect(() => config()).toThrow(LaunchError);
    // Fixed again: picked up, because the broken mtime was never recorded.
    write(JSON.stringify({ terminals: { shell: "/bin/sh", bins: { claude: "/bin/cat" } } }), 3000);
    expect(config().terminals.bins.claude).toBe("/bin/cat");
    rmSync(dir, { recursive: true });
  });

  test("the idle watch fires once nothing is busy, and never while something is", async () => {
    let busyFired = false;
    const busy = idleWatch(
      () => true,
      30,
      () => {
        busyFired = true;
      },
    );
    let idleFired = 0;
    idleWatch(
      () => false,
      30,
      () => {
        idleFired++;
      },
    );
    await Bun.sleep(200);
    clearInterval(busy);
    expect(busyFired).toBe(false);
    expect(idleFired).toBe(1);
  });

  test("only the host's start marks leftover running rows lost", async () => {
    const db = openDb(":memory:");
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
    const first = new TerminalManager(config, db, shellEnv);
    const { id } = await first.create({ harness: "shell", location: "app" });
    const state = () =>
      (db.query("SELECT state FROM terminal_sessions WHERE id = ?").get(id) as { state: string })
        .state;
    // A server builds no manager any more, but a second one must not touch the rows either.
    new TerminalManager(config, db, shellEnv);
    expect(state()).toBe("running");
    markLost(db);
    expect(state()).toBe("lost");
    await first.stopAll(200);
  });

  test("a launch prunes terminals that ended long ago; running and recent ones stay", async () => {
    const db = openDb(":memory:");
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const add = db.query(
      `INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at, ended_at)
       VALUES (?, 'shell', 'app', '/tmp', ?, ?, ?)`,
    );
    for (const state of ["exited", "failed", "lost"])
      add.run(`old-${state}`, state, ago(200), ago(91));
    add.run("recent", "exited", ago(30), ago(30));
    add.run("still-running", "running", ago(200), null);
    const manager = new TerminalManager(config, db, shellEnv);
    const { id } = await manager.create({ harness: "shell", location: "app" });
    const ids = db
      .query<{ id: string }, []>("SELECT id FROM terminal_sessions ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(ids).toEqual([id, "recent", "still-running"].sort());
    await manager.stopAll(200);
  });

  test("agents a host shutdown killed come back with the next host, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-resume-"));
    // A fake claude that records its argv and waits.
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\nsleep 30\n`, { mode: 0o755 });
    const config = ConfigSchema.parse({
      terminals: { shell: "/bin/sh", bins: { claude: bin } },
    });
    const db = openDb(":memory:");
    const row = (id: string) =>
      db
        .query<{ state: string; resumes: number; error: string | null }, [string]>(
          "SELECT state, resumes, error FROM terminal_sessions WHERE id = ?",
        )
        .get(id);
    const first = new TerminalManager(config, db, shellEnv);
    const agent = await first.create({ harness: "claude", location: "app", model: "m-1" });
    const shell = await first.create({ harness: "shell", location: "app" });
    first.rename(agent.id, "mi agente");
    const sid = "0ffb346e-5654-4c95-88a7-565b4cd05913";
    db.query("UPDATE terminal_sessions SET session_id = ? WHERE id = ?").run(sid, agent.id);
    await first.stopAll(200);
    // What the shutdown killed is not ended: the next host finds it running.
    expect(row(agent.id)?.state).toBe("running");

    const lost = markLost(db);
    expect(lost.map((l) => l.id).sort()).toEqual([agent.id, shell.id].sort());
    const next = new TerminalManager(config, db, shellEnv);
    await next.resumeLost(lost);
    await next.resumeLost(lost);
    const back = next.get(agent.id);
    expect(back?.state).toBe("running");
    expect(back?.name).toBe("mi agente");
    expect(next.list()).toHaveLength(1);
    expect(row(agent.id)).toEqual({ state: "running", resumes: 1, error: null });
    expect(row(shell.id)?.state).toBe("lost");
    await until(() => existsSync(join(dir, "args")));
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe(
      `--dangerously-skip-permissions --resume ${sid} --model m-1`,
    );
    await next.stopAll(200);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a crash loop stops at the resume cap; one whose folder is gone says why", async () => {
    const db = openDb(":memory:");
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
    const sid = "0ffb346e-5654-4c95-88a7-565b4cd05913";
    const insert = db.query(
      `INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at, session_id, resumes)
       VALUES (?, 'claude', ?, '/x', 'running', ?, ?, ?)`,
    );
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    insert.run("capped", "app", ago(60_000), sid, MAX_RESUMES);
    insert.run("gone", "repo:nope", ago(60_000), sid, 0);
    const manager = new TerminalManager(config, db, shellEnv);
    await manager.resumeLost(markLost(db));
    expect(manager.list()).toHaveLength(0);
    const error = (id: string) =>
      db
        .query<{ error: string | null }, [string]>(
          "SELECT error FROM terminal_sessions WHERE id = ?",
        )
        .get(id)?.error;
    expect(error("capped")).toBeNull();
    expect(error("gone")).toContain("not resumed: unknown location repo:nope");
  });

  test("a session that ran for a while counts its resumes again; a Codex without id picks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-resume-"));
    // Fake agents that record their argv and wait.
    const fakeBin = (name: string) => {
      const bin = join(dir, name);
      writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/${name}.args"\nsleep 30\n`, {
        mode: 0o755,
      });
      return bin;
    };
    const config = ConfigSchema.parse({
      terminals: { shell: "/bin/sh", bins: { claude: fakeBin("claude"), codex: fakeBin("codex") } },
    });
    const db = openDb(":memory:");
    const sid = "0ffb346e-5654-4c95-88a7-565b4cd05913";
    const insert = db.query(
      `INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at, session_id, resumes)
       VALUES (?, ?, 'app', '/x', 'running', ?, ?, ?)`,
    );
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    insert.run("stable", "claude", ago(STABLE_MS + 60_000), sid, MAX_RESUMES);
    insert.run("no-id", "codex", ago(60_000), null, 0);
    insert.run("claude-no-id", "claude", ago(60_000), null, 0);
    const manager = new TerminalManager(config, db, shellEnv);
    await manager.resumeLost(markLost(db));
    const resumes = (id: string) =>
      db
        .query<{ state: string; resumes: number }, [string]>(
          "SELECT state, resumes FROM terminal_sessions WHERE id = ?",
        )
        .get(id);
    expect(resumes("stable")).toEqual({ state: "running", resumes: 1 });
    expect(resumes("no-id")).toEqual({ state: "running", resumes: 1 });
    expect(resumes("claude-no-id")?.state).toBe("lost");
    await until(() => existsSync(join(dir, "codex.args")));
    expect(readFileSync(join(dir, "codex.args"), "utf8").trim()).toBe(
      "resume --dangerously-bypass-approvals-and-sandbox --no-alt-screen",
    );
    await manager.stopAll(200);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("PTY host app", () => {
  const token = "x".repeat(43);
  let manager: TerminalManager;
  let server: ReturnType<typeof Bun.serve>;
  let shutdowns = 0;
  const host = () => ({ port: server.port ?? 0, token, pid: process.pid, protocol: PROTOCOL });
  const client = () => new HostClient(() => Promise.resolve(host()), shellEnv);

  beforeAll(async () => {
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
    manager = new TerminalManager(config, openDb(":memory:"), shellEnv);
    const app = createHostApp(manager, token, {
      shutdown: () => {
        shutdowns++;
      },
    });
    const { websocket } = await import("hono/bun");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
  });
  afterAll(async () => {
    await manager.stopAll(200);
    server.stop(true);
  });

  const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers });

  test("every request needs the token and none may carry an Origin", async () => {
    expect((await call("/health")).status).toBe(401);
    expect((await call("/health", { authorization: `Bearer ${"y".repeat(43)}` })).status).toBe(401);
    expect((await call("/health", { authorization: "Bearer short" })).status).toBe(401);
    const auth = { authorization: `Bearer ${token}` };
    expect((await call("/health", { ...auth, origin: "http://127.0.0.1:4317" })).status).toBe(403);
    const ok = await call("/health", auth);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ protocol: PROTOCOL, pid: process.pid });
    const upgrade = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    expect((await call("/control", upgrade)).status).toBe(401);
    expect(
      (await call("/control", { ...upgrade, ...auth, origin: "http://evil.test" })).status,
    ).toBe(403);
  });

  test("snapshot and live output reach the window through the server, and a new server reattaches", async () => {
    const a = client();
    const info = await a.create({ harness: "shell", location: "app" });
    const w1 = fake();
    expect(await a.attach(info.id, w1.client)).toBe(true);
    await until(() => w1.got.some((d) => typeof d === "string" && d.includes('"snapshot"')));
    a.input(info.id, w1.client, "echo MARK_$((6*7))\r");
    await until(() => w1.out().includes("MARK_42"));

    // The server dies: its sockets drop, the terminal keeps running in the host.
    a.close();
    await until(() => manager.get(info.id)?.attached === false);
    expect(manager.get(info.id)?.state).toBe("running");

    const b = client();
    expect((await b.list()).map((t) => t.id)).toContain(info.id);
    const w2 = fake();
    await b.attach(info.id, w2.client);
    await until(() => w2.out().includes("MARK_42"));
    b.input(info.id, w2.client, "echo AGAIN_$((1+1))\r");
    await until(() => w2.out().includes("AGAIN_2"));
    expect(w1.state.closed).not.toBe(4001);

    // A window that does not take is told busy, through the server, and the holder stays.
    const asked = fake();
    await b.attach(info.id, asked.client);
    await until(() => asked.state.closed === 4409);
    expect(asked.out()).toContain('"busy"');
    expect(w2.state.closed).toBe(0);

    // One that takes it displaces the holder; the host's own close code reaches it.
    const w3 = fake();
    await b.attach(info.id, w3.client, true);
    await until(() => w2.state.closed === 4001);
    expect(await b.stop(info.id)).toBe(true);
    b.close();
  });

  test("a window that closes while the host comes up holds nothing", async () => {
    let up = () => {};
    const slow = new HostClient(
      () => new Promise((resolve) => (up = () => resolve(host()))),
      shellEnv,
    );
    const info = await client().create({ harness: "shell", location: "app" });
    const gone = fake();
    const pending = slow.attach(info.id, gone.client);
    gone.state.closed = 1001;
    slow.detach(info.id, gone.client);
    up();
    expect(await pending).toBe(true);
    // Without the guard the orphan socket would hold the terminal and this would be busy.
    const next = fake();
    await slow.attach(info.id, next.client);
    await until(() => next.got.some((d) => typeof d === "string" && d.includes('"snapshot"')));
    expect(next.state.closed).toBe(0);
    expect(await slow.stop(info.id)).toBe(true);
    slow.close();
  });

  test("an agent reads, types and waits through the host without displacing the window", async () => {
    const c = client();
    const info = await c.create({ harness: "shell", location: "app" });
    const w = fake();
    await c.attach(info.id, w.client);
    await until(() => w.got.some((d) => typeof d === "string" && d.includes('"snapshot"')));
    expect(await c.write(info.id, "echo HOST_$((6*7))\r")).toBe(true);
    // The typed line's echo comes first; under load the shell runs it more than quietMs later.
    await until(() => w.out().includes("HOST_42"), 15_000);
    const idle = await c.waitFor(info.id, { quietMs: 200, timeoutMs: 5000 });
    expect(idle?.reason).toBe("idle");
    const read = await c.read(info.id, 5);
    expect(read?.text).toContain("HOST_42");
    expect(w.out()).toContain("HOST_42");
    expect(w.state.closed).toBe(0);
    expect(manager.get(info.id)?.attached).toBe(true);
    expect(await c.read("nope")).toBeUndefined();
    expect(await c.waitFor("nope", {})).toBeUndefined();
    expect((await call(`/terminals/${info.id}/text`)).status).toBe(401);
    expect(await c.stop(info.id)).toBe(true);
    await until(() => manager.get(info.id)?.state !== "running");
    expect(await c.write(info.id, "x")).toBe(false);
    c.close();
  }, 30_000);

  test("a name set through the host stays in its memory and needs the token", async () => {
    const c = client();
    const info = await c.create({ harness: "shell", location: "app" });
    expect(await c.rename(info.id, "api")).toBe(true);
    expect((await c.get(info.id))?.name).toBe("api");
    expect(await c.rename("nope", "api")).toBe(false);
    const named = (body: unknown, auth = true) =>
      fetch(`http://127.0.0.1:${server.port}/terminals/${info.id}/name`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await named({ name: "x" }, false)).status).toBe(401);
    expect((await named({ name: "a\u202Eb" })).status).toBe(400);
    expect(manager.get(info.id)?.name).toBe("api");
    expect(await c.rename(info.id, null)).toBe(true);
    expect(manager.get(info.id)?.name).toBeNull();
    expect(await c.stop(info.id)).toBe(true);
    c.close();
  });

  describe("«Reiniciar»", () => {
    const sid = "0ffb346e-5654-4c95-88a7-565b4cd05913";
    // A fake claude that appends its argv to a file and waits.
    const setup = () => {
      const dir = mkdtempSync(join(tmpdir(), "aos-restart-"));
      const bin = join(dir, "claude");
      writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${dir}/args"\nsleep 30\n`, { mode: 0o755 });
      const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh", bins: { claude: bin } } });
      const db = openDb(":memory:");
      const manager = new TerminalManager(config, db, shellEnv);
      const argv = () =>
        existsSync(join(dir, "args"))
          ? readFileSync(join(dir, "args"), "utf8").trim().split("\n")
          : [];
      return { dir, db, manager, argv };
    };

    test("a running agent comes back with its id, name and --resume", async () => {
      const { dir, db, manager, argv } = setup();
      const agent = await manager.create({ harness: "claude", location: "app", model: "m-1" });
      manager.rename(agent.id, "mi agente");
      db.query("UPDATE terminal_sessions SET session_id = ? WHERE id = ?").run(sid, agent.id);
      await until(() => argv().length === 1);
      const result = await manager.restart(agent.id);
      expect(result && "terminal" in result && result.terminal.id).toBe(agent.id);
      const back = manager.get(agent.id);
      expect(back?.state).toBe("running");
      expect(back?.name).toBe("mi agente");
      expect(manager.list()).toHaveLength(1);
      await until(() => argv().length === 2);
      expect(argv()[1]).toBe(`--dangerously-skip-permissions --resume ${sid} --model m-1`);
      expect(
        db.query("SELECT state, resumes, error FROM terminal_sessions WHERE id = ?").get(agent.id),
      ).toEqual({ state: "running", resumes: 1, error: null });
      await manager.stopAll(200);
      rmSync(dir, { recursive: true, force: true });
    });

    test("two restarts at once relaunch once", async () => {
      const { dir, db, manager, argv } = setup();
      const agent = await manager.create({ harness: "claude", location: "app" });
      db.query("UPDATE terminal_sessions SET session_id = ? WHERE id = ?").run(sid, agent.id);
      await until(() => argv().length === 1);
      await Promise.all([manager.restart(agent.id), manager.restart(agent.id)]);
      await until(() => argv().length === 2);
      await Bun.sleep(300);
      expect(argv()).toHaveLength(2);
      expect(manager.get(agent.id)?.state).toBe("running");
      await manager.stopAll(200);
      rmSync(dir, { recursive: true, force: true });
    });

    test("without a session it refuses and the terminal keeps running", async () => {
      const { dir, manager, argv } = setup();
      const agent = await manager.create({ harness: "claude", location: "app" });
      await until(() => argv().length === 1);
      expect(await manager.restart(agent.id)).toEqual({ refused: "no_session" });
      expect(await manager.restart("nope")).toBeUndefined();
      await Bun.sleep(200);
      expect(manager.get(agent.id)?.state).toBe("running");
      expect(argv()).toHaveLength(1);
      manager.stop(agent.id);
      await until(() => manager.get(agent.id)?.state === "exited");
      expect(await manager.restart(agent.id)).toEqual({ refused: "not_running" });
      await manager.stopAll(200);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  test("an unexpected host failure answers a generic 500; its cause stays in the host", async () => {
    const broken: TerminalManager = Object.create(manager);
    broken.list = () => {
      throw new Error("cause with /private/path");
    };
    const res = await createHostApp(broken, token, {}).request("/terminals", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('"internal"');
    expect(body).not.toContain("/private/path");
  });

  test("an unknown terminal is 404, not an outage", async () => {
    const c = client();
    expect(await c.get("nope")).toBeUndefined();
    expect(await c.resume("nope")).toBeUndefined();
    // The real host's answers for an unknown id all match the shapes the client parses.
    expect(await c.launchStatus(crypto.randomUUID())).toBeNull();
    expect(await c.read("nope")).toBeUndefined();
    expect(await c.write("nope", "x")).toBe(false);
    expect(await c.stop("nope")).toBe(false);
    expect(await c.rename("nope", "n")).toBe(false);
    expect(await c.remove("nope")).toBe(false);
    const w = fake();
    await c.attach("nope", w.client);
    await until(() => w.state.closed !== 0);
    expect(w.state.closed).toBe(4404);
    c.close();
  });

  test("a slow window is dropped by the server with 4003 and the host lets go", async () => {
    const c = client();
    const info = await c.create({ harness: "shell", location: "app" });
    const w = fake();
    await c.attach(info.id, w.client);
    await until(() => w.got.length > 0);
    w.state.buffered = MAX_CLIENT_BUFFER + Buffer.byteLength(w.got[0] as string) + 1;
    c.input(info.id, w.client, "echo FLOOD\r");
    await until(() => w.state.closed === 4003);
    expect(w.got.some((d) => typeof d === "string" && d.includes('"slow"'))).toBe(true);
    await until(() => manager.get(info.id)?.attached === false);
    await c.stop(info.id);
    c.close();
  });

  test("the host's overflow notice and 4004 reach the window as they are", async () => {
    // Overflow needs output faster than the screen parses; a stub host sends what pty.ts does.
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "overflow" }));
          ws.close(4004, "overflow");
        },
        message() {},
      },
    });
    const c = new HostClient(
      () => Promise.resolve({ port: stub.port ?? 0, token, pid: process.pid, protocol: PROTOCOL }),
      shellEnv,
    );
    const w = fake();
    await c.attach("any", w.client);
    await until(() => w.state.closed !== 0);
    expect(w.state.closed).toBe(4004);
    expect(w.got).toContain(JSON.stringify({ type: "overflow" }));
    c.close();
    stub.stop(true);
  });

  test("a host that went away closes the window with 4503 and the next call fails typed", async () => {
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
    const own = new TerminalManager(config, openDb(":memory:"), shellEnv);
    const { websocket } = await import("hono/bun");
    const gone = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createHostApp(own, token).fetch,
      websocket,
    });
    const port = gone.port ?? 0;
    const c = new HostClient(
      () => Promise.resolve({ port, token, pid: process.pid, protocol: PROTOCOL }),
      shellEnv,
    );
    const info = await c.create({ harness: "shell", location: "app" });
    const w = fake();
    await c.attach(info.id, w.client);
    await until(() => w.got.length > 0);
    let changes = 0;
    c.subscribe(() => changes++);
    await own.stopAll(200);
    const beforeGone = changes;
    gone.stop(true);
    await until(() => w.state.closed !== 0);
    await until(() => changes > beforeGone); // control close: the list must be read again
    expect(w.state.closed).toBe(4503);
    await expect(c.list()).rejects.toThrow("PTY host unreachable");
    c.close();
  });

  test("the manager reports every change the list shows, until unsubscribed", async () => {
    let changes = 0;
    const unsubscribe = manager.subscribe(() => changes++);
    const seen = async (what: string, act: () => unknown) => {
      const before = changes;
      await act();
      await until(() => changes > before).catch(() => {
        throw new Error(`${what}: no change reported`);
      });
    };
    let id = "";
    await seen("start", async () => {
      id = (await manager.create({ harness: "shell", location: "app" })).id;
    });
    const w = fake();
    await seen("attach", () => manager.attach(id, w.client));
    await seen("detach", () => manager.detach(id, w.client));
    await seen("exit", () => manager.stop(id));
    await until(() => manager.get(id)?.state !== "running");
    await seen("remove", () => manager.remove(id));
    unsubscribe();
    const after = changes;
    await manager.create({ harness: "shell", location: "app" }).then((t) => manager.stop(t.id));
    await Bun.sleep(200);
    expect(changes).toBe(after);
  });

  test("a change in the host reaches the server's listeners over the control socket", async () => {
    const c = client();
    let changes = 0;
    c.subscribe(() => changes++);
    await c.list();
    await until(() => changes > 0); // control open: resync
    const opened = changes;
    const info = await manager.create({ harness: "shell", location: "app" });
    await until(() => changes > opened);
    manager.stop(info.id);
    c.close();
  });

  test("shutdown is refused while a terminal runs", async () => {
    const auth = { authorization: `Bearer ${token}` };
    // Earlier tests stop their shells without waiting; on a busy machine one may still run.
    await until(() => manager.list().every((t) => t.state !== "running"), 15_000);
    const info = await manager.create({ harness: "shell", location: "app" });
    const busy = await call("/shutdown", auth, "POST");
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "busy", running: 1 });
    manager.stop(info.id);
    await until(() => manager.get(info.id)?.state !== "running");
    expect((await call("/shutdown", auth, "POST")).status).toBe(200);
    await until(() => shutdowns === 1);
  }, 30_000);

  // «Reiniciar todo»: Windows has no SIGTERM, so the server asks the host itself.
  test("a forced shutdown stops a busy host, and only with the token", async () => {
    const info = await manager.create({ harness: "shell", location: "app" });
    expect((await call("/shutdown?force=1", {}, "POST")).status).toBe(401);
    expect(
      (await call("/shutdown?force=1", { authorization: `Bearer ${token}` }, "POST")).status,
    ).toBe(200);
    await until(() => shutdowns === 2);
    manager.stop(info.id);
  });
});

describe("PTY host build", () => {
  test("covers every module the entry reaches and the lockfile, nothing else", () => {
    const dir = tmp();
    const file = (name: string, text: string) => writeFileSync(join(dir, name), text);
    file(
      "main.ts",
      'import { a } from "./a.ts";\nimport type { T } from "./types.ts";\nconsole.log(a);\n',
    );
    file("a.ts", 'import { b } from "./sub/b.ts";\nexport const a = b;\n');
    mkdirSync(join(dir, "sub"));
    file("sub/b.ts", "export const b = 1;\n");
    file("types.ts", "export type T = number;\n");
    file("other.ts", "export const o = 1;\n");
    file("bun.lock", "{}");
    const build = () => hostBuild(join(dir, "main.ts"), join(dir, "bun.lock"));
    try {
      const first = build();
      expect(build()).toBe(first);
      // A module two imports away from the entry is part of the build.
      file("sub/b.ts", "export const b = 2;\n");
      const second = build();
      expect(second).not.toBe(first);
      // A file the entry never reaches is not.
      file("other.ts", "export const o = 2;\n");
      expect(build()).toBe(second);
      file("bun.lock", '{"x":1}');
      expect(build()).not.toBe(second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real host's build reaches the terminal manager", () => {
    expect(hostBuild()).toMatch(/^[0-9a-f]{16}$/);
  });

  // Every file the host reaches is part of its build, and a running host keeps its build for
  // hours. A provider or a page feature imported by accident makes it stale on every edit.
  const hostGraph = () => {
    const root = join(import.meta.dir, "..", "..");
    return importGraph(join(import.meta.dir, "main.ts")).map((f) => relative(root, f));
  };

  // The server's config.ts holds every feature's schema, so a new field would stale the host.
  test("the real host reaches no server config, keychain or provider feature", () => {
    const files = hostGraph();
    expect(files).toContain("server/features/terminals/pty.ts");
    expect(files).toContain("server/config-host.ts");
    const outside = files.filter((f) =>
      /^server\/(config|secrets)\.ts$|^server\/features\/(jira|github|kickoff|memory|prs|tickets|usage)\//.test(
        f,
      ),
    );
    expect(outside).toEqual([]);
  });

  // Only terminals belongs in the host. What is left of other features waits for the host
  // contract to carry resolved launches; this list may only shrink.
  test("the real host reaches no feature but terminals, beyond the listed leftovers", () => {
    const leftovers = [
      "server/features/coordination/adapters.ts",
      "server/features/coordination/runner.ts",
      "server/features/coordination/store.ts",
      "server/features/coordination/worker.ts",
      "server/features/envs/actions.ts",
      "server/features/envs/provider.ts",
      "server/features/git/run.ts",
      "server/features/projects/locations.ts",
      "server/features/projects/worktrees.ts",
      "server/provider-error.ts",
    ];
    const outside = hostGraph().filter(
      (f) =>
        f === "server/provider-error.ts" ||
        (f.startsWith("server/features/") && !f.startsWith("server/features/terminals/")),
    );
    expect(outside.sort()).toEqual(leftovers);
  });

  test("a /health answer of another shape is no host, never a guessed protocol", async () => {
    let body: unknown = { protocol: "10", pid: 1, running: 0 };
    const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body) });
    const at = { port: fake.port ?? 0, token: "t".repeat(43), pid: 1, protocol: PROTOCOL };
    try {
      expect(await health(at)).toBeUndefined();
      body = { protocol: PROTOCOL, pid: 1, running: 0, extra: true };
      expect(await health(at)).toEqual({ protocol: PROTOCOL, pid: 1, running: 0 });
    } finally {
      fake.stop(true);
    }
  });

  test("a host is used only with this protocol and build; otherwise replaced once idle", () => {
    const h = (o: Partial<Health>): Health => ({
      protocol: PROTOCOL,
      pid: 1,
      running: 0,
      build: "b1",
      ...o,
    });
    expect(verdict(undefined, "b1")).toBe("start");
    expect(verdict(h({}), "b1")).toBe("use");
    expect(verdict(h({ running: 2 }), "b1")).toBe("use");
    expect(verdict(h({}), "b2")).toBe("replace");
    // A host file from before builds were recorded has none: never taken for this build.
    expect(verdict(h({ build: undefined }), "b1")).toBe("replace");
    expect(verdict(h({ build: undefined, running: 1 }), "b1")).toBe("use-stale");
    expect(verdict(h({ running: 1 }), "b2")).toBe("use-stale");
    expect(verdict(h({ protocol: PROTOCOL - 1 }), "b1")).toBe("replace");
    expect(verdict(h({ protocol: PROTOCOL - 1, running: 1 }), "b1")).toBe("refuse");
  });
});

// The one test that starts a real host process, as the server does.
describe("PTY host process", () => {
  const dir = tmp();
  const home = join(dir, "home");
  const env = { ...process.env, AGENTIC_OS_DATA: dir, HOME: home };
  let pid = 0;

  beforeAll(() => {
    mkdirSync(home);
    // The server migrates before it starts a host; the host only checks.
    openDb(join(dir, "agentic-os.db")).close();
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        providers: { github: false },
        terminals: {
          shell: "/bin/sh",
          bins: { claude: "/bin/sh", codex: "/bin/sh", grok: "/bin/sh" },
        },
      }),
    );
  });
  afterAll(async () => {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      await until(() => readHostFile(hostPaths(dir).file) === undefined).catch(() => {
        process.kill(pid, "SIGKILL");
      });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("an idle host that will not stop is reported, never run beside a new one", async () => {
    // A host of another build that answers its health and never its shutdown.
    const fakeDir = join(dir, "hung", "host");
    mkdirSync(fakeDir, { recursive: true });
    const token = "t".repeat(32);
    writeFileSync(
      join(fakeDir, "main.ts"),
      `const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) =>
        new URL(req.url).pathname === "/health"
          ? Response.json({ protocol: ${PROTOCOL}, pid: process.pid, running: 0, build: "old" })
          : new Promise(() => {}) });
      console.log(server.port);`,
    );
    const hung = Bun.spawn([process.execPath, join(fakeDir, "main.ts")], { stdout: "pipe" });
    try {
      const reader = hung.stdout.getReader();
      const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
      const own = tmp();
      writeHostFile(hostPaths(own).file, {
        port,
        token,
        pid: hung.pid,
        protocol: PROTOCOL,
        build: "old",
      });
      const started = Date.now();
      await expect(connectHost(own, { env, build: "new", stopMs: 300 })).rejects.toThrow(
        `the old PTY host (pid ${hung.pid}) did not stop in 0.3 s`,
      );
      expect(Date.now() - started).toBeLessThan(3000);
      // Nothing new was started in its place.
      expect(readHostFile(hostPaths(own).file)?.pid).toBe(hung.pid);
      rmSync(own, { recursive: true, force: true });
    } finally {
      hung.kill();
    }
  });

  test("starts detached, is reused by the next server, and cleans up on SIGTERM", async () => {
    const found = await connectHost(dir, { env, build: "one" });
    pid = found.pid;
    expect(found.protocol).toBe(PROTOCOL);
    expect(found.build).toBe("one");
    expect(statSync(hostPaths(dir).file).mode & 0o777).toBe(0o600);
    expect((await connectHost(dir, { env, build: "one" })).pid).toBe(pid);

    const c = new HostClient(() => connectHost(dir, { env, build: "one" }), shellEnv);
    const info = await c.create({ harness: "shell", location: "app" });
    const w = fake();
    await c.attach(info.id, w.client);
    c.input(info.id, w.client, "echo HOSTED_$((2*3))\r");
    await until(() => w.out().includes("HOSTED_6"));
    expect((await c.pids()).size).toBe(1);

    // Another build of the same protocol keeps the host while a terminal runs in it, marked
    // stale so the top bar can say new terminals still get its code...
    const kept = await connectHost(dir, { env, build: "two" });
    expect(kept.pid).toBe(pid);
    expect(kept.stale).toBe(true);
    await c.stop(info.id);
    for (let i = 0; (await c.get(info.id))?.state === "running"; i++) {
      if (i > 100) throw new Error("the shell did not stop");
      await Bun.sleep(50);
    }
    c.close();
    // ...and replaces it once nothing runs there.
    const next = await connectHost(dir, { env, build: "two" });
    expect(next.pid).not.toBe(pid);
    expect(next.stale).toBeUndefined();
    expect(next.build).toBe("two");
    const old = pid;
    pid = next.pid;
    await until(() => {
      try {
        process.kill(old, 0);
        return false;
      } catch {
        return true;
      }
    });

    process.kill(pid, "SIGTERM");
    await until(() => readHostFile(hostPaths(dir).file) === undefined);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    pid = 0;
  }, 20_000);
});

describe("PTY host env commands", () => {
  const token = "z".repeat(43);
  let dir: string;
  let manager: TerminalManager;
  let server: ReturnType<typeof Bun.serve>;
  const client = () =>
    new HostClient(
      () =>
        Promise.resolve({ port: server.port ?? 0, token, pid: process.pid, protocol: PROTOCOL }),
      shellEnv,
    );

  beforeAll(() => {
    dir = tmp();
    const bin = join(dir, "envcli");
    writeFileSync(bin, `#!/bin/sh\necho "$*" > "${dir}/argv.txt"\n`, { mode: 0o755 });
    mkdirSync(join(dir, "root"));
    const config = ConfigSchema.parse({
      envs: { bin, root: join(dir, "root"), repos: ["backend"] },
      terminals: { shell: "/bin/sh" },
    });
    manager = new TerminalManager(config, openDb(":memory:"), shellEnv);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createHostApp(manager, token).fetch,
    });
  });
  afterAll(async () => {
    await manager.stopAll(200);
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a command runs through the host, and a refusal comes back in its words", async () => {
    const c = client();
    const t = await c.runEnv({ action: "doctor" });
    expect(t).toMatchObject({ harness: "env", action: "doctor", env: null });
    const err = await c
      .runEnv({ action: "remove", name: "env-a", confirm: "si" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as Error).message).toBe("type env-a to confirm remove");
    const bad = await fetch(`http://127.0.0.1:${server.port}/envs/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ req: { action: "rm -rf" }, size: {} }),
    });
    expect(bad.status).toBe(400);
    c.close();
  });
});
