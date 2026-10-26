import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_ACTIONS, type EnvAction } from "../../../shared/envs.ts";
import type { RunEnvRequest } from "../../../shared/host-contract.ts";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { cleanEnv } from "../terminals/env.ts";
import { LaunchError } from "../terminals/harness.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import {
  conflict,
  envActionArgv,
  heldTerminals,
  removeBlocker,
  runningCommands,
} from "./actions.ts";

const env = cleanEnv({ PATH: "/usr/bin:/bin" }, {});

// A fake env CLI: `list --json` prints the listed envs; any other command appends its argv
// as one line to $DIR/calls.txt, then waits while $DIR/hold exists, so a test can keep a
// command running.
let dir: string;
let root: string;
let bin: string;
const cfg = () => ({ bin, root, repos: ["backend", "frontend"] });

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-env-actions-")));
  root = join(dir, "worktrees");
  for (const name of ["env-a", "env-ab"])
    mkdirSync(join(root, name, "backend", ".git"), { recursive: true });
  writeFileSync(
    join(dir, "list.json"),
    JSON.stringify([
      { env: "env-a", branch: "ABC-1", repos: [] },
      { env: "env-ab", branch: "ABC-2", repos: [] },
    ]),
  );
  bin = join(dir, "envcli");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = list ]; then cat "${dir}/list.json"; exit 0; fi
echo "$*" >> "${dir}/calls.txt"
while [ -f "${dir}/hold" ]; do sleep 0.05; done
`,
  );
  chmodSync(bin, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  rmSync(join(dir, "hold"), { force: true });
  rmSync(join(dir, "calls.txt"), { force: true });
});

const request = (action: EnvAction, name?: string): RunEnvRequest => ({
  action,
  ...(name !== undefined && { name }),
  ...(action === "remove" && name !== undefined && { confirm: name }),
});
const ONE_ENV: EnvAction[] = ["start", "stop", "update", "remove", "logs"];

describe("env action argv", () => {
  test("each action has its fixed argv; only start carries --yes, none --force", () => {
    const argv = Object.fromEntries(
      ENV_ACTIONS.map((a) => [
        a,
        envActionArgv(cfg(), request(a, ONE_ENV.includes(a) ? "env-a" : undefined))
          .slice(1)
          .join(" "),
      ]),
    );
    expect(argv).toEqual({
      start: "start env-a --yes",
      stop: "stop env-a",
      update: "update env-a",
      remove: "remove env-a",
      logs: "logs env-a --follow",
      doctor: "doctor",
    });
    // start --yes only skips "which other envs to stop?" and stops none; remove keeps its
    // confirmation, so only a job that checked the typed name adds --yes to it.
    for (const [action, line] of Object.entries(argv))
      expect(line.replace(action === "start" ? / --yes$/ : /$^/, "")).not.toMatch(
        /--yes|--force|-y\b/,
      );
  });

  test("an env action needs a valid env; a global one takes none", () => {
    for (const bad of [
      { action: "start" },
      { action: "start", name: "--yes" },
      { action: "logs", name: "Env A" },
      { action: "doctor", name: "env-a" },
      { action: "proxy", name: "env-a" },
    ] as RunEnvRequest[]) {
      expect(() => envActionArgv(cfg(), bad)).toThrow(LaunchError);
    }
  });

  test("remove needs the env's name typed", () => {
    for (const confirm of [undefined, "", "env-ab", "ENV-A", " env-a"])
      expect(() =>
        envActionArgv(cfg(), {
          action: "remove",
          name: "env-a",
          ...(confirm !== undefined && { confirm }),
        }),
      ).toThrow("type env-a to confirm remove");
    expect(envActionArgv(cfg(), request("remove", "env-a")).slice(1)).toEqual(["remove", "env-a"]);
  });

  test("no provider configured refuses every action", () => {
    expect(() => envActionArgv(undefined, request("doctor"))).toThrow("no env provider");
  });
});

describe("env command conflicts", () => {
  const run = (action: EnvAction | "create", envName: string | null = null) => ({
    action,
    env: envName,
  });

  test("one env takes one command at a time; other envs and reads go on", () => {
    expect(conflict(run("stop", "env-a"), [run("start", "env-a")])).toBe(
      "env env-a is busy with start",
    );
    expect(conflict(run("create", "env-a"), [run("update", "env-a")])).toBe(
      "env env-a is busy with update",
    );
    expect(conflict(run("stop", "env-a"), [run("start", "env-b")])).toBeNull();
    expect(conflict(run("logs", "env-a"), [run("start", "env-a")])).toBeNull();
    expect(conflict(run("start", "env-a"), [run("logs", "env-a")])).toBeNull();
  });

  test("the provider's tooling only conflicts with itself", () => {
    expect(conflict(run("doctor"), [run("doctor")])).toBe("doctor is already running");
    expect(conflict(run("doctor"), [run("start", "env-a"), run("create", "env-b")])).toBeNull();
    expect(conflict(run("start", "env-a"), [run("doctor")])).toBeNull();
  });
});

describe("what runs in terminals, as the env rules see it", () => {
  const t = (over: Partial<Parameters<typeof runningCommands>[0][number]>) => ({
    id: "t",
    harness: "env" as const,
    state: "running" as const,
    env: "env-a",
    action: "start" as const,
    cwd: "/w",
    name: null,
    ...over,
  });

  test("only running env commands count", () => {
    expect(
      runningCommands([
        t({}),
        t({ state: "exited" }),
        t({ harness: "shell", action: null }),
        t({ action: null }),
      ]),
    ).toEqual([{ action: "start", env: "env-a" }]);
  });

  test("remove waits for any command of the env and any terminal inside its folder", () => {
    const dir = "/w/env-a";
    expect(removeBlocker([t({ action: "logs" })], dir, "env-a")).toBe("env env-a still runs logs");
    expect(
      removeBlocker([t({ harness: "shell", env: null, cwd: "/w/env-a/backend" })], dir, "env-a"),
    ).toBe("la terminal «shell» sigue abierta en env-a/backend: párala antes de borrar");
    expect(
      removeBlocker(
        [
          t({ env: "env-ab" }),
          t({ state: "exited" }),
          t({ harness: "shell", env: null, cwd: "/w/env-ab/backend" }),
        ],
        dir,
        "env-a",
      ),
    ).toBeNull();
  });

  test("the terminals a remove would close: inside the folder, not the env's own commands", () => {
    const dir = "/w/env-a";
    const shell = (id: string, cwd: string, name: string | null = null) =>
      t({ id, harness: "shell", env: null, action: null, cwd, name });
    expect(
      heldTerminals(
        [
          shell("a", "/w/env-a/backend", "claude"),
          shell("b", "/w/env-a"),
          shell("c", "/w/env-ab/backend"),
          { ...shell("d", "/w/env-a"), state: "exited" },
          t({ action: "logs" }),
        ],
        dir,
        "env-a",
      ),
    ).toEqual([
      { id: "a", name: "claude", folder: "env-a/backend" },
      { id: "b", name: "shell", folder: "env-a" },
    ]);
  });
});

describe("env commands in terminals", () => {
  const manager = () =>
    new TerminalManager(
      ConfigSchema.parse({ envs: cfg(), terminals: { shell: "/bin/sh" } }),
      openDb(":memory:"),
      () => Promise.resolve(env),
    );
  const calls = () =>
    existsSync(join(dir, "calls.txt"))
      ? readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n")
      : [];
  const settle = async (m: TerminalManager, id: string) => {
    for (let i = 0; i < 100 && m.get(id)?.state === "running"; i++) await Bun.sleep(20);
    return m.get(id);
  };

  test("runs at the provider's root, marked with its env and command", async () => {
    const m = manager();
    try {
      const t = await m.runEnv({ action: "update", name: "env-a" });
      expect(t).toMatchObject({
        harness: "env",
        env: "env-a",
        action: "update",
        location: "envs",
        cwd: root,
      });
      expect((await settle(m, t.id))?.exitCode).toBe(0);
      const g = await m.runEnv({ action: "doctor" });
      expect(g).toMatchObject({ env: null, action: "doctor" });
      await settle(m, g.id);
      expect(calls()).toEqual(["update env-a", "doctor"]);
    } finally {
      await m.stopAll(200);
    }
  });

  test("an env the provider does not list is refused before anything runs", async () => {
    const m = manager();
    await expect(m.runEnv({ action: "start", name: "env-zz" })).rejects.toThrow(
      "env env-zz is not listed",
    );
    expect(m.list()).toHaveLength(0);
    expect(calls()).toEqual([]);
  });

  test("two commands on one env at the same moment start one process", async () => {
    writeFileSync(join(dir, "hold"), "");
    const m = manager();
    try {
      const [a, b] = await Promise.allSettled([
        m.runEnv({ action: "start", name: "env-a" }),
        m.runEnv({ action: "stop", name: "env-a" }),
      ]);
      expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
      expect(m.list().filter((t) => t.state === "running")).toHaveLength(1);
      // Another env and a read go on; a create of the busy env does not.
      await m.runEnv({ action: "start", name: "env-ab" });
      await m.runEnv({ action: "logs", name: "env-a" });
      await expect(
        m.createEnv({ name: "env-a", repos: ["backend"], branch: "ABC-1" }),
      ).rejects.toThrow("env env-a is busy");
    } finally {
      await m.stopAll(200);
    }
  });

  test("remove is refused while anything runs inside the env, its logs included", async () => {
    writeFileSync(join(dir, "hold"), "");
    const m = manager();
    try {
      const shell = await m.create({ harness: "shell", location: "env:env-a/backend" });
      await expect(m.runEnv(request("remove", "env-a"))).rejects.toThrow(
        "la terminal «shell» sigue abierta en env-a/backend: párala antes de borrar",
      );
      m.stop(shell.id);
      await settle(m, shell.id);
      const logs = await m.runEnv({ action: "logs", name: "env-a" });
      await expect(m.runEnv(request("remove", "env-a"))).rejects.toThrow(
        "env env-a still runs logs",
      );
      m.stop(logs.id);
      await settle(m, logs.id);
      // A shell in env-ab, whose name starts with env-a, is not inside env-a.
      await m.create({ harness: "shell", location: "env:env-ab/backend" });
      const removed = await m.runEnv(request("remove", "env-a"));
      expect(removed).toMatchObject({ env: "env-a", action: "remove" });
      for (let i = 0; i < 100 && !calls().includes("remove env-a"); i++) await Bun.sleep(20);
      expect(calls()).toContain("remove env-a");
    } finally {
      await m.stopAll(200);
    }
  });

  test("the create command is marked too", async () => {
    const m = manager();
    try {
      const t = await m.createEnv({ name: "env-new", repos: ["backend"], branch: "ABC-9" });
      expect(t).toMatchObject({ env: "env-new", action: "create", ticket: "ABC-9" });
    } finally {
      await m.stopAll(200);
    }
  });
});

describe("POST /api/envs/run", () => {
  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request("/api/envs/run", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const make = () => {
    const config = ConfigSchema.parse({ port: 4317, envs: cfg(), terminals: { shell: "/bin/sh" } });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () => Promise.resolve(env));
    return { app: createApp({ config, db, terminals, tokens: new AttachTokens() }), terminals };
  };

  test("an unknown action is a bad request; a refusal comes back in words", async () => {
    const { app, terminals } = make();
    try {
      expect((await post(app, { action: "create", name: "env-a" })).status).toBe(400);
      expect((await post(app, { action: "start", name: "--yes" })).status).toBe(400);
      const refused = await post(app, { action: "remove", name: "env-a", confirm: "nope" });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "launch_rejected",
        detail: "type env-a to confirm remove",
      });
      const ok = await post(app, { action: "doctor" });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { terminal: { action: string } }).terminal.action).toBe(
        "doctor",
      );
    } finally {
      await terminals.stopAll(200);
    }
  });
});
