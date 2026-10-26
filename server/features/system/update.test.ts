import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../../deps.ts";
import type { Restarter } from "../../restart.ts";
import { systemRoutes } from "./routes.ts";
import {
  type ApplyDeps,
  afterExit,
  applyBundle,
  appVersion,
  beforeStart,
  CARRIED_ASSETS,
  installPending,
  newPairing,
  packBundle,
  paired,
  receivedVersion,
  type StartDeps,
  TRIAL_MS,
} from "./update.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-update-"));
afterAll(() => rmSync(dir, { recursive: true }));

// A hub tree with code, a test and the package files, and a worker's app and data.
function trees(name: string) {
  const hub = join(dir, name, "hub");
  const app = join(dir, name, "app");
  const data = join(dir, name, "data");
  for (const d of [join(hub, "server"), join(app, "server"), data])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(hub, "server", "index.ts"), "export const v = 2;\n");
  writeFileSync(join(hub, "server", "index.test.ts"), "test\n");
  writeFileSync(join(hub, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(hub, "bun.lock"), "lock 1\n");
  writeFileSync(join(app, "server", "index.ts"), "export const v = 1;\n");
  writeFileSync(join(app, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(app, "bun.lock"), "lock 1\n");
  return { hub, app, data };
}

const deps = (t: ReturnType<typeof trees>, over: Partial<ApplyDeps> = {}): ApplyDeps => ({
  appRoot: t.app,
  dataDir: t.data,
  preflight: async () => null,
  log: () => {},
  managed: true,
  ...over,
});

test("a bundle lands over the app without the hub's tests, and the version is kept", async () => {
  const t = trees("lands");
  const bundle = await packBundle(t.hub, join(dir, "lands", "pack"));
  expect(await applyBundle(bundle, "0123456789abcdef", deps(t))).toBeNull();
  expect(readFileSync(join(t.app, "server", "index.ts"), "utf8")).toContain("v = 2");
  expect(() => readFileSync(join(t.app, "server", "index.test.ts"))).toThrow();
  expect(receivedVersion(t.data)).toBe("0123456789abcdef");
});

test("assets refresh carried over from earlier builds stay on the hub", async () => {
  const t = trees("carried");
  mkdirSync(join(t.hub, "dist", "assets"), { recursive: true });
  writeFileSync(join(t.hub, "dist", "index.html"), "<html></html>\n");
  writeFileSync(join(t.hub, "dist", "assets", "app-new.js"), "new\n");
  writeFileSync(join(t.hub, "dist", "assets", "app-old.js"), "old\n");
  writeFileSync(join(t.hub, "dist", CARRIED_ASSETS), '["app-old.js"]\n');
  const bundle = await packBundle(t.hub, join(dir, "carried", "pack"));
  expect(await applyBundle(bundle, "0123456789abcdef", deps(t))).toBeNull();
  expect(readFileSync(join(t.app, "dist", "assets", "app-new.js"), "utf8")).toBe("new\n");
  expect(existsSync(join(t.app, "dist", "assets", "app-old.js"))).toBe(false);
  expect(existsSync(join(t.app, "dist", CARRIED_ASSETS))).toBe(false);
});

test("code that would not start leaves the app as it was", async () => {
  const t = trees("refused");
  const bundle = await packBundle(t.hub, join(dir, "refused", "pack"));
  const broken = await applyBundle(bundle, "0123456789abcdef", {
    ...deps(t),
    preflight: async () => "el código no compila: x",
  });
  expect(broken).toContain("no compila");
  expect(readFileSync(join(t.app, "server", "index.ts"), "utf8")).toContain("v = 1");
  expect(installPending(t.data)).toBe(false);
});

// The supervisor's side, with fakes for the host and `bun install`.
function starts(t: ReturnType<typeof trees>, over: Partial<StartDeps> = {}) {
  const lines: string[] = [];
  const installs: string[] = [];
  let now = 1_000_000;
  const d: StartDeps = {
    appRoot: t.app,
    dataDir: t.data,
    hostAlive: async () => false,
    install: async () => {
      installs.push("install");
      return { code: 0, stderr: "" };
    },
    log: (line) => lines.push(line),
    now: () => now,
    ...over,
  };
  return { d, lines, installs, later: (ms: number) => (now += ms) };
}

test("new packages install before the next start, once the PTY host is gone", async () => {
  const t = trees("packages");
  writeFileSync(join(t.hub, "bun.lock"), "lock 2\n");
  const bundle = await packBundle(t.hub, join(dir, "packages", "pack"));
  expect(await applyBundle(bundle, "0123456789abcdef", deps(t))).toBeNull();
  expect(installPending(t.data)).toBe(true);
  let alive = true;
  const s = starts(t, { hostAlive: async () => alive });
  await beforeStart(s.d);
  expect(s.installs).toEqual([]);
  alive = false;
  await beforeStart(s.d);
  expect(s.installs).toEqual(["install"]);
  expect(installPending(t.data)).toBe(false);
});

test("a failed install keeps the mark for the next start", async () => {
  const t = trees("install-fails");
  writeFileSync(join(t.hub, "package.json"), '{"name":"y"}\n');
  await applyBundle(
    await packBundle(t.hub, join(dir, "install-fails", "pack")),
    "0123456789abcdef",
    deps(t),
  );
  const s = starts(t, { install: async () => ({ code: 1, stderr: "offline" }) });
  await beforeStart(s.d);
  expect(installPending(t.data)).toBe(true);
  expect(s.lines.join()).toContain("offline");
});

test("three failed starts in the trial put the previous app back, files and all", async () => {
  const t = trees("rollback");
  writeFileSync(join(t.data, "app-version"), "1111111111111111\n");
  writeFileSync(join(t.hub, "bun.lock"), "lock 2\n");
  writeFileSync(join(t.hub, "server", "added.ts"), "export {};\n");
  await applyBundle(
    await packBundle(t.hub, join(dir, "rollback", "pack")),
    "2222222222222222",
    deps(t),
  );
  const s = starts(t);
  await beforeStart(s.d);
  // A busy lock is not the new code's fault; one crash may be passing.
  expect(afterExit(s.d, 3)).toBe(false);
  for (const _ of [1, 2]) {
    s.later(5_000);
    expect(afterExit(s.d, 1)).toBe(false);
    await beforeStart(s.d);
  }
  expect(readFileSync(join(t.app, "server", "index.ts"), "utf8")).toContain("v = 2");
  expect(afterExit(s.d, 1)).toBe(true);
  expect(readFileSync(join(t.app, "server", "index.ts"), "utf8")).toContain("v = 1");
  expect(existsSync(join(t.app, "server", "added.ts"))).toBe(false);
  expect(readFileSync(join(t.app, "bun.lock"), "utf8")).toBe("lock 1\n");
  expect(receivedVersion(t.data)).toBe("1111111111111111");
  // The old lockfile is back, so its packages are installed again.
  expect(installPending(t.data)).toBe(true);
  expect(afterExit(s.d, 1)).toBe(false);
});

test("a corrupt bundle is refused before anything is touched", async () => {
  const t = trees("corrupt");
  const refused = await applyBundle(
    new TextEncoder().encode("not a tarball"),
    "0123456789abcdef",
    deps(t),
  );
  expect(refused).toContain("descomprimir");
  expect(readFileSync(join(t.app, "server", "index.ts"), "utf8")).toContain("v = 1");
  expect(existsSync(join(t.data, "update-trial.json"))).toBe(false);
});

test("an update that outlives the trial, or stops cleanly, is kept", async () => {
  const t = trees("kept");
  const bundle = await packBundle(t.hub, join(dir, "kept", "pack"));
  await applyBundle(bundle, "0123456789abcdef", deps(t));
  // The next update waits until this one has proved itself.
  expect(await applyBundle(bundle, "0123456789abcdef", deps(t))).toContain("espera");
  const s = starts(t);
  await beforeStart(s.d);
  s.later(TRIAL_MS + 1);
  expect(afterExit(s.d, 1)).toBe(false);
  expect(existsSync(join(t.data, "update-trial.json"))).toBe(false);
  expect(readFileSync(join(t.app, "server", "index.ts"), "utf8")).toContain("v = 2");
  const clean = trees("clean");
  await applyBundle(
    await packBundle(clean.hub, join(dir, "clean", "pack")),
    "0123456789abcdef",
    deps(clean),
  );
  const c = starts(clean);
  await beforeStart(c.d);
  expect(afterExit(c.d, 0)).toBe(false);
  expect(readFileSync(join(clean.app, "server", "index.ts"), "utf8")).toContain("v = 2");
});

// A supervisor from before automatic installs: it never stamps a trial nor installs.
test("under an older supervisor: no trial, and new packages are refused", async () => {
  const t = trees("unmanaged");
  const bundle = await packBundle(t.hub, join(dir, "unmanaged", "pack"));
  expect(await applyBundle(bundle, "0123456789abcdef", deps(t, { managed: false }))).toBeNull();
  expect(await applyBundle(bundle, "0123456789abcdef", deps(t, { managed: false }))).toBeNull();
  writeFileSync(join(t.hub, "bun.lock"), "lock 2\n");
  const locked = await packBundle(t.hub, join(dir, "unmanaged", "pack"));
  expect(await applyBundle(locked, "0123456789abcdef", deps(t, { managed: false }))).toContain(
    "worker.ps1 start",
  );
  expect(installPending(t.data)).toBe(false);
});

test("a trial whose server never started is dropped after a while", async () => {
  const t = trees("abandoned");
  const bundle = await packBundle(t.hub, join(dir, "abandoned", "pack"));
  await applyBundle(bundle, "0123456789abcdef", deps(t));
  const file = join(t.data, "update-trial.json");
  const trial = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...trial, appliedAt: trial.appliedAt - 6 * 60_000 }));
  expect(await applyBundle(bundle, "0123456789abcdef", deps(t))).toBeNull();
});

test("two updates at once: the second is refused", async () => {
  const t = trees("twice");
  const bundle = await packBundle(t.hub, join(dir, "twice", "pack"));
  const [a, b] = await Promise.all([
    applyBundle(bundle, "0123456789abcdef", deps(t)),
    applyBundle(bundle, "0123456789abcdef", deps(t)),
  ]);
  expect([a, b]).toEqual([null, "ya hay una actualización en marcha"]);
});

test("the version follows any bundled file and ignores tests", () => {
  const t = trees("version");
  const before = appVersion(t.hub);
  writeFileSync(join(t.hub, "server", "index.test.ts"), "changed\n");
  expect(appVersion(t.hub)).toBe(before);
  utimesSync(join(t.hub, "server", "index.ts"), new Date(), new Date(Date.now() + 5000));
  expect(appVersion(t.hub)).not.toBe(before);
  expect(before).toMatch(/^[0-9a-f]{16}$/);
});

test("only the token the pairing printed passes; the data folder keeps its hash", async () => {
  const t = trees("pair");
  expect(paired(t.data, "Bearer anything")).toBe(false);
  const token = await newPairing(t.data);
  expect(readFileSync(join(t.data, "pairing.json"), "utf8")).not.toContain(token);
  expect(paired(t.data, `Bearer ${token}`)).toBe(true);
  expect(paired(t.data, `Bearer ${token}x`)).toBe(false);
  expect(paired(t.data, token)).toBe(false);
  expect(paired(t.data, undefined)).toBe(false);
});

test("the update route wants the token before it reads the bundle, and a supervisor", async () => {
  const t = trees("route");
  const token = await newPairing(t.data);
  const applied: string[] = [];
  const restarts: string[] = [];
  const restart = {
    unsupervised: async () => null,
    start: async (scope: string) => {
      restarts.push(scope);
      return null;
    },
  } as unknown as Restarter;
  const routes = (r: Restarter) =>
    systemRoutes({
      restart: r,
      update: {
        dataDir: t.data,
        apply: async (_bundle: Uint8Array, version: string) => {
          applied.push(version);
          return null;
        },
      },
    } as unknown as Deps);
  const post = (r: Restarter, auth?: string) =>
    routes(r).request("/update", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ version: "0123456789abcdef", bundle: "AAAA" }),
    });
  expect((await post(restart)).status).toBe(401);
  expect((await post(restart, "Bearer wrong")).status).toBe(401);
  const lone = { unsupervised: async () => "sin supervisor" } as unknown as Restarter;
  const refused = await post(lone, `Bearer ${token}`);
  expect([refused.status, ((await refused.json()) as { detail: string }).detail]).toEqual([
    409,
    "sin supervisor",
  ]);
  expect(applied).toEqual([]);
  expect((await post(restart, `Bearer ${token}`)).status).toBe(202);
  expect([applied, restarts]).toEqual([["0123456789abcdef"], ["server"]]);
  // Packages to install: the PTY host stops too, so the install finds nothing holding them.
  writeFileSync(join(t.data, "install-pending"), "");
  expect((await post(restart, `Bearer ${token}`)).status).toBe(202);
  expect(restarts).toEqual(["server", "all"]);
});
