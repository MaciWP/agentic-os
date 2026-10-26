import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RestartDeps, Restarter, startupProblem, stopHost, supervisedBy } from "./restart.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-restart-"));
afterAll(() => rmSync(dir, { recursive: true }));

function fakes(over: Partial<RestartDeps> = {}) {
  const steps: string[] = [];
  let hostAlive = true;
  let exited: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const deps: RestartDeps = {
    supervised: () => true,
    preflight: async () => null,
    quiesce: () => steps.push("quiesce"),
    hostPid: () => 42,
    isHostPid: async () => hostAlive,
    stopHost: async (pid) => {
      steps.push(`kill ${pid}`);
      hostAlive = false;
      return true;
    },
    sleep: async () => {},
    rebuildWeb: async () => {
      steps.push("web");
      return { built: true };
    },
    exit: async () => {
      steps.push("exit");
      exited();
    },
    log: () => {},
    ...over,
  };
  return { deps, steps, done };
}

test("a full restart stops serving, then the host, then exits for the supervisor", async () => {
  const { deps, steps, done } = fakes();
  expect(await new Restarter(deps).start("all")).toBeNull();
  await done;
  expect(steps).toEqual(["web", "quiesce", "kill 42", "exit"]);
});

test("a full restart whose page fails to build still restarts, keeping the old page", async () => {
  const lines: string[] = [];
  const { deps, steps, done } = fakes({
    rebuildWeb: async () => ({ failed: "vite: syntax error" }),
    log: (line) => lines.push(line),
  });
  expect(await new Restarter(deps).start("all")).toBeNull();
  await done;
  expect(steps).toEqual(["quiesce", "kill 42", "exit"]);
  expect(lines).toContain("restart: web not rebuilt, the old one stays: vite: syntax error");
});

test("a full restart with the page already built from this code says so", async () => {
  const lines: string[] = [];
  const { deps, done } = fakes({
    rebuildWeb: async () => ({ built: false }),
    log: (line) => lines.push(line),
  });
  expect(await new Restarter(deps).start("all")).toBeNull();
  await done;
  expect(lines).toContain("restart: web already current");
});

test("a server restart leaves the host and its terminals alone", async () => {
  const { deps, steps, done } = fakes();
  expect(await new Restarter(deps).start("server")).toBeNull();
  await done;
  expect(steps).toEqual(["quiesce", "exit"]);
});

test("a host that will not stop is kept: the server still exits and comes back", async () => {
  const { deps, steps, done } = fakes({
    stopHost: async (pid) => {
      steps.push(`kill ${pid}`);
      return true;
    },
  });
  expect(await new Restarter(deps, 0).start("all")).toBeNull();
  await done;
  expect(steps).toEqual(["web", "quiesce", "kill 42", "exit"]);
});

test("without the supervisor, or with a start that would fail, nothing is touched", async () => {
  const lone = fakes({ supervised: () => false });
  expect(await new Restarter(lone.deps).start("all")).toContain("supervisor");
  const broken = fakes({ preflight: async () => "config.json no es válido: x" });
  const restarter = new Restarter(broken.deps);
  expect(await restarter.start("all")).toBe("config.json no es válido: x");
  const thrown = fakes({ preflight: () => Promise.reject(new Error("boom")) });
  expect(await new Restarter(thrown.deps).start("all")).toContain("boom");
  await Bun.sleep(300);
  expect([...lone.steps, ...broken.steps, ...thrown.steps]).toEqual([]);
});

// A host answers a forced shutdown itself; one from before `force` refuses while busy.
async function fakeHost(answer: number) {
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      asked.push(
        `${new URL(req.url).pathname}${new URL(req.url).search} ${req.headers.get("authorization")}`,
      );
      return new Response(null, { status: answer });
    },
  });
  const host = { port: server.port ?? 0, token: "t".repeat(43), pid: 4242, protocol: 10 };
  return { host, asked, stop: () => server.stop(true) };
}

test("the host is asked to stop over its API, with its token, on every platform", async () => {
  const { host, asked, stop } = await fakeHost(200);
  const signals: number[] = [];
  await stopHost(host, (pid) => signals.push(pid), "win32");
  await stopHost(host, (pid) => signals.push(pid), "darwin");
  stop();
  expect(asked).toEqual(Array(2).fill(`/shutdown?force=1 Bearer ${"t".repeat(43)}`));
  expect(signals).toEqual([]);
});

test("an older host that refuses: SIGTERM on POSIX, kept on Windows", async () => {
  const { host, stop } = await fakeHost(409);
  const signals: string[] = [];
  expect(await stopHost(host, (pid) => signals.push(`darwin ${pid}`), "darwin")).toBe(true);
  expect(await stopHost(host, (pid) => signals.push(`win32 ${pid}`), "win32")).toBe(false);
  stop();
  expect(signals).toEqual(["darwin 4242"]);
});

test("a host that refuses is not waited for: the server exits at once", async () => {
  const polls: number[] = [];
  const { deps, steps, done } = fakes({
    stopHost: async () => false,
    isHostPid: async (pid) => {
      polls.push(pid);
      return true;
    },
    log: (line) => steps.push(line),
  });
  expect(await new Restarter(deps).start("all")).toBeNull();
  await done;
  expect(polls).toEqual([42]);
  expect(steps).toEqual([
    "restart: server and PTY host",
    "web",
    "restart: web rebuilt",
    "quiesce",
    "restart: PTY host 42 refused to stop; kept",
    "exit",
  ]);
});

test("a second click while one runs is refused", async () => {
  let release: () => void = () => {};
  const slow = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  const { deps, done } = fakes({ preflight: () => slow });
  const restarter = new Restarter(deps);
  const first = restarter.start("all");
  expect(await restarter.start("server")).toBe("ya hay un reinicio en marcha");
  release();
  expect(await first).toBeNull();
  await done;
});

test("only the supervisor named in its pid file, and alive, counts as the parent", async () => {
  const file = join(dir, "supervisor.pid");
  expect(await supervisedBy(join(dir, "none.pid"), 1)).toBe(false);
  writeFileSync(file, `${process.pid}\n`);
  // This test runner is not scripts/supervise.ts, and a different parent never matches.
  expect(await supervisedBy(file, process.pid)).toBe(false);
  expect(await supervisedBy(file, process.pid + 1)).toBe(false);
});

test("a config that no longer parses, or code that does not compile, blocks the restart", async () => {
  const root = join(dir, "app");
  mkdirSync(join(root, "server", "host"), { recursive: true });
  writeFileSync(join(root, "server", "index.ts"), `export const a = 1;\n`);
  writeFileSync(join(root, "server", "host", "main.ts"), `import "./gone.ts";\n`);
  const ok = () => ({});
  expect(await startupProblem(root, ok)).toContain("el código no compila");
  writeFileSync(join(root, "server", "host", "main.ts"), `export const b = ;\n`);
  expect(await startupProblem(root, ok)).toContain("el código no compila");
  writeFileSync(join(root, "server", "host", "main.ts"), `export const b = 2;\n`);
  expect(await startupProblem(root, ok)).toBeNull();
  expect(
    await startupProblem(root, () => {
      throw new Error("remote: origin");
    }),
  ).toBe("config.json no es válido: remote: origin");
});
