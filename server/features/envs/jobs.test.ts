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
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { cleanEnv } from "../terminals/env.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import {
  type EnvJob,
  EnvJobs,
  type JobRequest,
  KEEP_FINISHED,
  OUTPUT_MAX,
  plainText,
} from "./jobs.ts";
import { removePreview } from "./provider.ts";

const env = cleanEnv({ PATH: "/usr/bin:/bin" }, {});

// A fake env CLI. The reads print the JSON in $DIR (`<name>.json`, or fail when it is missing);
// every other command appends its argv to $DIR/calls.txt, writes a coloured line and a
// redrawn one to stdout and a line to stderr, waits while $DIR/hold exists, prints 300 KB when
// $DIR/big exists, and exits with the code in $DIR/code.
let dir: string;
let root: string;
let bin: string;
const cfg = () => ({ bin, root, repos: ["backend", "frontend"] });

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-env-jobs-")));
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
read_json() { [ -f "${dir}/$1.json" ] || { echo "$1 broke" >&2; exit 4; }; cat "${dir}/$1.json"; exit 0; }
[ "$1" = list ] && read_json list
[ "$1" = shared ] && read_json shared
[ "$1" = proxy ] && read_json proxy
[ "$1" = remove ] && [ "$3" = --dry-run ] && read_json preview
echo "$*" >> "${dir}/calls.txt"
printf '\\033[32m%s\\033[0m\\n50%%\\r100%%\\n' "$1 begins"
echo "a warning" >&2
while [ -f "${dir}/hold" ]; do sleep 0.05; done
[ -f "${dir}/big" ] && { head -c 300000 /dev/zero | tr '\\0' x; echo END; }
exit $(cat "${dir}/code" 2>/dev/null || echo 0)
`,
  );
  chmodSync(bin, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const f of ["hold", "big", "code", "calls.txt", "shared.json", "proxy.json", "preview.json"])
    rmSync(join(dir, f), { force: true });
});

const calls = () =>
  existsSync(join(dir, "calls.txt"))
    ? readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n")
    : [];

// What the fake's `remove --dry-run --json` answers: nothing to lose unless given.
const preview = (
  dirty: Record<string, string[]> = {},
  unpublished: Record<string, string[]> = {},
) =>
  writeFileSync(
    join(dir, "preview.json"),
    JSON.stringify({ ok: true, dry_run: true, dirty, unpublished, recoverable_only: false }),
  );

// The terminals the jobs check against, set per test; only what the rules read.
let open: TerminalInfo[] = [];
let stopped: string[] = [];
const terminal = (over: Partial<TerminalInfo>) =>
  ({
    harness: "shell",
    state: "running",
    env: null,
    action: null,
    cwd: "/w",
    ...over,
  }) as TerminalInfo;
const jobs = () =>
  new EnvJobs({
    config: ConfigSchema.parse({ envs: cfg() }),
    terminals: {
      env: Promise.resolve(env),
      list: () => open,
      stop: (id: string) => {
        stopped.push(id);
        open = open.map((t) => (t.id === id ? { ...t, state: "exited" } : t));
        return true;
      },
      remove: (id: string) => {
        open = open.filter((t) => t.id !== id);
        return true;
      },
    } as unknown as Terminals,
  });
const settle = async (j: EnvJobs, id: string) => {
  for (let i = 0; i < 200 && j.get(id)?.state === "running"; i++) await Bun.sleep(20);
  return j.get(id) as EnvJob;
};

describe("env jobs", () => {
  afterEach(() => {
    open = [];
    stopped = [];
  });

  test("runs at the provider's root and keeps what it wrote as plain text", async () => {
    const j = jobs();
    const seen: string[] = [];
    j.changes.add((job) => seen.push(job.state));
    const started = await j.start({ action: "update", name: "env-a" });
    expect(started).toMatchObject({ action: "update", env: "env-a", state: "running" });
    expect(started).not.toHaveProperty("output");
    const done = await settle(j, started.id);
    expect(done).toMatchObject({ state: "ok", error: null, truncated: false });
    expect(done.endedAt).not.toBeNull();
    // Colours out, the redrawn line split, stderr kept beside stdout.
    expect(done.output).toContain("update begins\n");
    expect(done.output).toContain("50%\n100%\n");
    expect(done.output).toContain("a warning\n");
    expect(done.output).not.toContain("\x1b");
    expect(seen).toEqual(["running", "ok"]);
    expect(calls()).toEqual(["update env-a"]);
  });

  test("create, remove and start answer the provider's prompts with --yes; nothing else does", async () => {
    preview();
    const j = jobs();
    for (const req of [
      { action: "create", name: "env-new", repos: ["backend"], branch: "ABC-9" },
      { action: "remove", name: "env-a", confirm: "env-a" },
      { action: "start", name: "env-ab" },
      { action: "doctor" },
    ] satisfies JobRequest[])
      await settle(j, (await j.start(req)).id);
    expect(calls()).toEqual([
      "create env-new --repos backend --branch feature/ABC-9 --new --yes",
      "remove env-a --yes",
      "start env-ab --yes",
      "doctor",
    ]);
  });

  test("a remove without the env's name typed, or of an env not listed, never runs", async () => {
    const j = jobs();
    await expect(j.start({ action: "remove", name: "env-a", confirm: "env-ab" })).rejects.toThrow(
      "type env-a to confirm remove",
    );
    await expect(j.start({ action: "stop", name: "env-zz" })).rejects.toThrow(
      "env env-zz is not listed",
    );
    expect(j.list()).toEqual([]);
    expect(calls()).toEqual([]);
  });

  test("a failed command says how it ended and keeps its output", async () => {
    writeFileSync(join(dir, "code"), "3");
    const j = jobs();
    const done = await settle(j, (await j.start({ action: "start", name: "env-a" })).id);
    expect(done).toMatchObject({ state: "failed", error: "exited with 3" });
    expect(done.output).toContain("start begins");
  });

  test("a long output keeps its end", async () => {
    writeFileSync(join(dir, "big"), "");
    const j = jobs();
    const done = await settle(j, (await j.start({ action: "doctor" })).id);
    expect(done.truncated).toBe(true);
    expect(done.output).toHaveLength(OUTPUT_MAX);
    expect(done.output.endsWith("END\n")).toBe(true);
  });

  test("one env takes one command at a time, from a job or from a terminal", async () => {
    writeFileSync(join(dir, "hold"), "");
    const j = jobs();
    const [a, b] = await Promise.allSettled([
      j.start({ action: "start", name: "env-a" }),
      j.start({ action: "stop", name: "env-a" }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    // Another env and the provider's check-up go on; a second check-up does not.
    await j.start({ action: "start", name: "env-ab" });
    await j.start({ action: "doctor" });
    await expect(j.start({ action: "doctor" })).rejects.toThrow("doctor is already running");
    // What the terminals see: a running job blocks a command started there.
    expect(j.blocker({ action: "update", env: "env-a" })).toMatch(/^env env-a is busy with /);
    expect(j.blocker({ action: "logs", env: "env-a" })).toBeNull();
    rmSync(join(dir, "hold"));
    for (const job of j.list()) await settle(j, job.id);

    open = [terminal({ harness: "env", env: "env-a", action: "update", state: "running" })];
    await expect(j.start({ action: "start", name: "env-a" })).rejects.toThrow(
      "env env-a is busy with update",
    );
  });

  test("a remove closes the open terminals the user saw, and waits for any other", async () => {
    preview();
    const j = jobs();
    const req = { action: "remove", name: "env-a", confirm: "env-a" } as const;
    const inside = (id: string, env = "env-a") =>
      terminal({ id, harness: "claude", name: "claude", cwd: join(root, env, "backend") });
    // Not listed to the user: never closed, it blocks.
    open = [inside("t1")];
    await expect(j.start(req)).rejects.toThrow(
      "la terminal «claude» sigue abierta en env-a/backend: párala antes de borrar",
    );
    expect(stopped).toEqual([]);
    // Listed: closed first. A seen id outside the env is left alone.
    open = [inside("t1"), inside("t2", "env-ab")];
    await settle(j, (await j.start({ ...req, close: ["t1", "t2"] })).id);
    expect(stopped).toEqual(["t1"]);
    expect(open.map((t) => [t.id, t.state])).toEqual([["t2", "running"]]);
    expect(calls()).toEqual(["remove env-a --yes"]);
  });

  test("a remove that cannot run closes nothing", async () => {
    preview();
    const j = jobs();
    open = [
      terminal({ id: "u", harness: "env", env: "env-a", action: "update" }),
      terminal({ id: "t1", harness: "claude", cwd: join(root, "env-a") }),
    ];
    await expect(
      j.start({ action: "remove", name: "env-a", confirm: "env-a", close: ["t1"] }),
    ).rejects.toThrow("env env-a is busy with update");
    expect(stopped).toEqual([]);
  });

  test("a remove closes the env's own logs first, and only those", async () => {
    preview();
    const j = jobs();
    const logs = (id: string, name: string) =>
      terminal({ id, harness: "env", env: name, action: "logs", state: "running" });
    open = [logs("l1", "env-a"), logs("l2", "env-a"), logs("l3", "env-b")];
    await settle(j, (await j.start({ action: "remove", name: "env-a", confirm: "env-a" })).id);
    expect(stopped).toEqual(["l1", "l2"]);
    expect(open.map((t) => [t.id, t.state])).toEqual([["l3", "running"]]);
    expect(calls()).toEqual(["remove env-a --yes"]);
  });

  test("a done remove takes the env's ended terminals off the list; a failed one keeps them", async () => {
    preview();
    const j = jobs();
    const inEnv = join(root, "env-a", "backend");
    const others = [
      terminal({ id: "other", harness: "env", env: "env-b", action: "logs", state: "exited" }),
      terminal({ id: "near", state: "exited", cwd: join(root, "env-ab") }),
    ];
    const ended = [
      terminal({ id: "old", harness: "env", env: "env-a", action: "update", state: "exited" }),
      terminal({ id: "agent", harness: "claude", state: "exited", cwd: inEnv }),
    ];
    open = [...ended, ...others];
    writeFileSync(join(dir, "code"), "3");
    await settle(j, (await j.start({ action: "remove", name: "env-a", confirm: "env-a" })).id);
    expect(open.map((t) => t.id)).toEqual(["old", "agent", "other", "near"]);
    rmSync(join(dir, "code"));
    await settle(j, (await j.start({ action: "remove", name: "env-a", confirm: "env-a" })).id);
    expect(open.map((t) => t.id)).toEqual(["other", "near"]);
  });

  test("a remove that loses work runs with --force-dirty only for the losses the user saw", async () => {
    const j = jobs();
    const remove = { action: "remove", name: "env-a", confirm: "env-a" } as const;
    preview({ backend: ["?? reports/"] }, { contract: ["abc123 wip"] });
    const { fingerprint } = await removePreview(cfg(), env, "env-a");
    await expect(j.start(remove)).rejects.toThrow("hay cambios pendientes");
    await expect(j.start({ ...remove, seen: "0".repeat(64) })).rejects.toThrow("ha cambiado");
    // Something new showed up after the user looked: refused, nothing runs.
    preview({ backend: ["?? reports/", " M src/app.py"] }, { contract: ["abc123 wip"] });
    await expect(j.start({ ...remove, seen: fingerprint })).rejects.toThrow("ha cambiado");
    expect(calls()).toEqual([]);
    preview({ backend: ["?? reports/"] }, { contract: ["abc123 wip"] });
    await settle(j, (await j.start({ ...remove, seen: fingerprint })).id);
    expect(calls()).toEqual(["remove env-a --yes --force-dirty"]);
  });

  test("the fingerprint follows the losses, not the order the provider lists them in", async () => {
    const hash = async (dirty: Record<string, string[]>) => {
      preview(dirty);
      return (await removePreview(cfg(), env, "env-a")).fingerprint;
    };
    const first = await hash({ backend: [" M a"], contract: [" M b"] });
    expect(await hash({ contract: [" M b"], backend: [" M a"], frontend: [] })).toBe(first);
    expect(await hash({ backend: [" M a"], contract: [" M c"] })).not.toBe(first);
  });

  test("a clean env never gets --force-dirty, whatever the client sends", async () => {
    preview();
    const j = jobs();
    const seen = "a".repeat(64);
    await settle(
      j,
      (await j.start({ action: "remove", name: "env-a", confirm: "env-a", seen })).id,
    );
    expect(calls()).toEqual(["remove env-a --yes"]);
  });

  test("a dry run that fails stops the remove", async () => {
    const j = jobs();
    await expect(j.start({ action: "remove", name: "env-a", confirm: "env-a" })).rejects.toThrow(
      "preview broke",
    );
    expect(calls()).toEqual([]);
  });

  test(`only the last ${KEEP_FINISHED} finished jobs are kept, newest first`, async () => {
    const j = jobs();
    const ids: string[] = [];
    for (let i = 0; i < KEEP_FINISHED + 2; i++) {
      const job = await j.start({ action: "doctor" });
      ids.push(job.id);
      await settle(j, job.id);
    }
    expect(j.list().map((x) => x.id)).toEqual(ids.slice(2).reverse());
    expect(j.get(ids[0] as string)).toBeNull();
  });
});

test("plain text: escapes out, carriage returns end a line, tabs and newlines stay", () => {
  expect(plainText("\x1b[1;31mred\x1b[0m\x1b]0;title\x07\tok\r\nnext\rover\x00\x08")).toBe(
    "red\tok\nnext\nover",
  );
});

describe("/api/envs jobs and reads", () => {
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "content-type": "application/json",
  };
  const make = () => {
    const config = ConfigSchema.parse({ port: 4317, envs: cfg(), terminals: { shell: "/bin/sh" } });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () => Promise.resolve(env));
    return { app: createApp({ config, db, terminals, tokens: new AttachTokens() }), terminals };
  };
  const get = (app: ReturnType<typeof createApp>, path: string) =>
    app.request(path, { headers: { host: headers.host } });
  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request("/api/envs/jobs", { method: "POST", headers, body: JSON.stringify(body) });

  test("a job starts, its output reads back, and a refusal comes in words", async () => {
    const { app, terminals } = make();
    try {
      expect((await post(app, { action: "logs", name: "env-a" })).status).toBe(400);
      expect((await post(app, { action: "start", name: "--yes" })).status).toBe(400);
      const refused = await post(app, { action: "remove", name: "env-a", confirm: "nope" });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "launch_rejected",
        detail: "type env-a to confirm remove",
      });
      const ok = await post(app, { action: "doctor" });
      expect(ok.status).toBe(201);
      const { job } = (await ok.json()) as { job: { id: string } };
      let read: { job: EnvJob } | undefined;
      for (let i = 0; i < 100 && read?.job.state !== "ok"; i++) {
        read = (await (await get(app, `/api/envs/jobs/${job.id}`)).json()) as { job: EnvJob };
        await Bun.sleep(20);
      }
      expect(read?.job.output).toContain("doctor begins");
      expect(
        ((await (await get(app, "/api/envs/jobs")).json()) as { jobs: unknown[] }).jobs,
      ).toHaveLength(1);
      expect((await get(app, "/api/envs/jobs/nope")).status).toBe(404);
    } finally {
      await terminals.stopAll(200);
    }
  });

  test("the status shows each part with its own error", async () => {
    writeFileSync(join(dir, "shared.json"), JSON.stringify({ running: 3, envs: ["env-a"] }));
    const { app } = make();
    expect(await (await get(app, "/api/envs/status")).json()).toEqual({
      configured: true,
      shared: { value: { running: 3, envs: ["env-a"], ports: {} }, error: null },
      proxy: { value: null, error: expect.stringContaining("proxy broke") },
    });
  });

  test("the remove preview names what would be lost, and only for a listed env", async () => {
    writeFileSync(
      join(dir, "preview.json"),
      JSON.stringify({
        env: "env-a",
        ok: true,
        dry_run: true,
        dirty: { backend: [" M a.ts"], frontend: [] },
        unpublished: {},
        recoverable_only: false,
        warnings: [{ step: "docker", detail: "not running", log: "x" }],
      }),
    );
    const { app } = make();
    expect(await (await get(app, "/api/envs/env-a/remove-preview")).json()).toEqual({
      preview: {
        dirty: { backend: [" M a.ts"] },
        unpublished: {},
        recoverableOnly: false,
        warnings: ["docker: not running"],
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        open: [],
      },
    });
    expect((await get(app, "/api/envs/env-zz/remove-preview")).status).toBe(404);
    // The provider's refusal of the dry run is an error, never "nothing to lose".
    writeFileSync(join(dir, "preview.json"), JSON.stringify({ ok: false, error: "boom" }));
    expect((await get(app, "/api/envs/env-a/remove-preview")).status).toBe(502);
  });
});
