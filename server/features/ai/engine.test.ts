import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AiEngine,
  AiError,
  aiPaths,
  type EngineConfig,
  type EngineProcess,
  engineArgv,
} from "./engine.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "aos-ai-"));
  dirs.push(d);
  return d;
};

const cfg: EngineConfig = {
  bin: "/opt/llama/llama-server",
  model: "/models/q.gguf",
  draft: "/models/mtp.gguf",
  template: "/models/claude.jinja",
  port: 8090,
  contextTokens: 131072,
  reasoningBudget: -1,
  idleMinutes: 15,
};

// A llama-server the test drives: it turns healthy when told, and records its kill.
function fakeEngine() {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    exit = r;
  });
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  const state = { healthy: false, killed: false, spawns: 0, argv: [] as string[] };
  const proc: EngineProcess = {
    pid: 4242,
    exited,
    stderr: new ReadableStream({
      start(c) {
        stderr = c;
      },
    }),
    kill: () => {
      state.killed = true;
      state.healthy = false;
      exit(1);
    },
  };
  // Each request's body: written by the test, ended when it says so.
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetch = async (url: string) => {
    if (url.endsWith("/health")) {
      if (!state.healthy) throw new Error("connection refused");
      return new Response("{}");
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          bodies.push(c);
        },
      }),
      { headers: { "content-type": "text/event-stream", "content-length": "9" } },
    );
  };
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    proc,
    state,
    bodies,
    timers,
    log: (text: string) => stderr.enqueue(new TextEncoder().encode(text)),
    crash: (code: number) => exit(code),
    deps: (dataDir: string, extra = {}) => ({
      dataDir,
      spawn: (argv: string[]) => {
        state.spawns++;
        state.argv = argv;
        return proc;
      },
      fetch,
      sleep: async () => {},
      timer: (fn: () => void, ms: number) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      alive: () => false,
      ...extra,
    }),
  };
}

// Healthy on the second poll, as a real start is.
const healthySoon = (f: ReturnType<typeof fakeEngine>) => {
  let polls = 0;
  return {
    sleep: async () => {
      if (++polls === 1) f.state.healthy = true;
    },
  };
};

describe("AiEngine", () => {
  test("builds the measured flags on loopback, with the drafter and the template", () => {
    const argv = engineArgv(cfg);
    expect(argv[0]).toBe(cfg.bin);
    expect(argv.join(" ")).toContain("--host 127.0.0.1 --port 8090 --alias local");
    expect(argv.join(" ")).toContain("-md /models/mtp.gguf");
    expect(argv.join(" ")).toContain("--chat-template-file /models/claude.jinja");
    expect(argv.join(" ")).toContain("-np 1");
    expect(argv.some((a) => a.includes("log-prompt"))).toBe(false);
    // Unlimited thinking is llama-server's own default, so no flag; a budget caps it.
    expect(argv).not.toContain("--reasoning-budget");
    expect(engineArgv({ ...cfg, reasoningBudget: 0 }).join(" ")).toContain("--reasoning-budget 0");
  });

  test("concurrent first requests start one engine, which then idles out", async () => {
    const dir = tmp();
    const f = fakeEngine();
    const engine = new AiEngine(cfg, f.deps(dir, healthySoon(f)));
    await Promise.all([engine.ensure(), engine.ensure(), engine.ensure()]);
    expect(f.state.spawns).toBe(1);
    expect(engine.state()).toMatchObject({ state: "ready", inFlight: 0 });
    expect(JSON.parse(readFileSync(aiPaths(dir).pid, "utf8"))).toEqual({ pid: 4242 });
    const idle = f.timers.at(-1);
    expect(idle?.ms).toBe(15 * 60_000);
    idle?.fn();
    expect(f.state.killed).toBe(true);
    expect(engine.state().state).toBe("off");
    expect(existsSync(aiPaths(dir).pid)).toBe(false);
  });

  test("a streamed answer holds the engine busy until its body ends", async () => {
    const f = fakeEngine();
    const engine = new AiEngine(cfg, f.deps(tmp(), healthySoon(f)));
    const res = await engine.forward("/v1/messages?beta=true", { method: "POST" });
    expect(res.headers.get("content-length")).toBeNull();
    expect(engine.state().inFlight).toBe(1);
    const armed = f.timers.filter((t) => !t.cancelled);
    expect(armed).toEqual([]);
    const reading = res.text();
    f.bodies[0]?.enqueue(new TextEncoder().encode("data: hi\n\n"));
    f.bodies[0]?.close();
    expect(await reading).toBe("data: hi\n\n");
    expect(engine.state().inFlight).toBe(0);
    expect(f.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  test("a caller that leaves mid-answer frees the engine too", async () => {
    const f = fakeEngine();
    const engine = new AiEngine(cfg, f.deps(tmp(), healthySoon(f)));
    const res = await engine.forward("/v1/messages", { method: "POST" });
    await res.body?.cancel();
    expect(engine.state().inFlight).toBe(0);
  });

  test("game mode stops the engine, refuses starts and survives a restart", async () => {
    const dir = tmp();
    const f = fakeEngine();
    const engine = new AiEngine(cfg, f.deps(dir, healthySoon(f)));
    await engine.ensure();
    engine.setGameMode(true);
    expect(f.state.killed).toBe(true);
    const again = new AiEngine(cfg, f.deps(dir));
    expect(again.state().gameMode).toBe(true);
    const refused = await again.ensure().catch((e) => e);
    expect(refused).toBeInstanceOf(AiError);
    expect((refused as AiError).code).toBe("ai_game_mode");
    expect(f.state.spawns).toBe(1);
    again.setGameMode(false);
    expect(again.state().gameMode).toBe(false);
  });

  test("an engine that dies on its own is reported as failed", async () => {
    const f = fakeEngine();
    const engine = new AiEngine(cfg, f.deps(tmp(), healthySoon(f)));
    await engine.ensure();
    f.crash(3);
    await Bun.sleep(0);
    expect(engine.state()).toMatchObject({
      state: "failed",
      detail: "el motor terminó con código 3",
    });
  });

  test("a port that already answers is someone else's: no spawn", async () => {
    const f = fakeEngine();
    f.state.healthy = true;
    const engine = new AiEngine(cfg, f.deps(tmp()));
    const err = await engine.ensure().catch((e) => e);
    expect((err as AiError).message).toContain("no es un motor arrancado por Agentic OS");
    expect(f.state.spawns).toBe(0);
    expect(engine.state().state).toBe("failed");
  });

  test("a start that never turns healthy is stopped at the deadline", async () => {
    const f = fakeEngine();
    let t = 0;
    const engine = new AiEngine(cfg, f.deps(tmp(), { now: () => (t += 60_000), startMs: 120_000 }));
    const err = await engine.ensure().catch((e) => e);
    expect((err as AiError).message).toBe("el motor no ha arrancado a tiempo");
    expect(f.state.killed).toBe(true);
  });

  test("a leftover is ended only when its command line is our engine on our port", async () => {
    const dir = tmp();
    const killed: number[] = [];
    const run = async (cmd: string) => {
      writeFileSync(aiPaths(dir).pid, JSON.stringify({ pid: 77 }));
      let alive = true;
      const engine = new AiEngine(cfg, {
        dataDir: dir,
        alive: () => alive,
        commandLine: async () => cmd,
        killTree: (pid) => {
          killed.push(pid);
          alive = false;
        },
        sleep: async () => {},
      });
      await engine.reapLeftover();
      expect(existsSync(aiPaths(dir).pid)).toBe(false);
    };
    await run("C:/Windows/notepad.exe");
    await run("/opt/llama/llama-server -m x --port 9999");
    expect(killed).toEqual([]);
    await run("/opt/llama/llama-server -m /models/q.gguf --port 8090 --alias local");
    expect(killed).toEqual([77]);
  });

  test("the engine's own lines go to its log", async () => {
    const dir = tmp();
    const f = fakeEngine();
    const engine = new AiEngine(cfg, f.deps(dir, healthySoon(f)));
    await engine.ensure();
    f.log("srv  load_model: ok\n");
    await Bun.sleep(5);
    expect(readFileSync(aiPaths(dir).log, "utf8")).toBe("srv  load_model: ok\n");
  });
});
