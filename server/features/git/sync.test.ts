import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { TerminalInfo, TerminalState } from "../terminals/contract.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { exclusive, fastForward, GitRefusal, submodulePath, updateRepos } from "./sync.ts";

const GIT = "/usr/bin/git";

let dir: string;
let gitEnv: Record<string, string>;
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([GIT, ...args], { cwd, env: gitEnv, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
};

// A bare origin, the checkout under test and a second clone that pushes to the origin.
function fixture() {
  const root = join(dir, `case-${++n}`);
  mkdirSync(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const work = join(root, "work");
  git(root, "clone", "-q", origin, work);
  commit(work, "a.txt");
  git(work, "push", "-q", "-u", "origin", "main");
  const pusher = join(root, "pusher");
  git(root, "clone", "-q", origin, pusher);
  return { work, pusher, at: { bin: GIT, cwd: work, env: gitEnv } };
}

// The origin changes a.txt, the file the checkout has edited too.
function clash() {
  const f = fixture();
  writeFileSync(join(f.pusher, "a.txt"), "theirs\n");
  git(f.pusher, "commit", "-q", "-am", "theirs");
  git(f.pusher, "push", "-q");
  writeFileSync(join(f.work, "a.txt"), "mine\n");
  return f;
}

// A repo with a submodule "lib", cloned with it, and a pusher that moves the submodule on.
function withSubmodule() {
  const f = fixture();
  const root = join(f.work, "..");
  const lib = join(root, "lib.git");
  git(root, "init", "-q", "--bare", "-b", "main", lib);
  const libWork = join(root, "lib-work");
  git(root, "clone", "-q", lib, libWork);
  commit(libWork, "one.txt");
  git(libWork, "push", "-q", "-u", "origin", "main");
  git(f.pusher, "submodule", "add", "-q", lib, "lib");
  git(f.pusher, "commit", "-q", "-m", "lib");
  git(f.pusher, "push", "-q");
  git(f.work, "pull", "-q");
  git(f.work, "submodule", "update", "-q", "--init");
  // The origin moves lib on and records it.
  commit(libWork, "two.txt");
  git(libWork, "push", "-q");
  git(join(f.pusher, "lib"), "pull", "-q", "origin", "main");
  git(f.pusher, "commit", "-q", "-am", "lib two");
  git(f.pusher, "push", "-q");
  return { ...f, lib: join(f.work, "lib"), recorded: () => git(f.pusher, "rev-parse", "HEAD:lib") };
}

// Two commits on the origin that the checkout has not fetched yet.
function behind() {
  const f = fixture();
  commit(f.pusher, "b.txt");
  commit(f.pusher, "c.txt");
  git(f.pusher, "push", "-q");
  return f;
}

const term = (cwd: string, state: TerminalState = "running") => ({ cwd, state }) as TerminalInfo;
const none = { list: () => [] as TerminalInfo[] };
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GitRefusal);
  return (err as GitRefusal).reason;
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-sync-")));
  gitEnv = {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    // Submodules from a local path (git refuses the file protocol for them by default).
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
  };
});
// Removing the test repos took 23 s at load 37 (native, 2026-10-08), after every test had
// passed; Bun gives a hook 5 s. The cleanup gets the time it needs.
afterAll(() => rmSync(dir, { recursive: true, force: true }), 60_000);

describe("fast-forward", () => {
  test("fetches, then moves the current branch to its upstream; a second run has nothing", async () => {
    const { work, pusher, at } = behind();
    const from = git(work, "rev-parse", "HEAD");
    const r = await fastForward(at, none);
    expect(r).toEqual({
      result: "updated",
      branch: "main",
      from,
      to: git(pusher, "rev-parse", "HEAD"),
      commits: 2,
      submodules: null,
    });
    expect(git(work, "rev-parse", "HEAD")).toBe(git(pusher, "rev-parse", "HEAD"));
    expect(await fastForward(at, none)).toMatchObject({ result: "up_to_date", commits: 0 });
  });

  test("local changes block it only where the update would overwrite them, as git decides", async () => {
    const f = behind();
    writeFileSync(join(f.work, "notes.txt"), "mine\n");
    writeFileSync(join(f.work, "a.txt"), "edited\n");
    expect((await fastForward(f.at, none)).result).toBe("updated");
    // The edit is still there.
    expect(git(f.work, "status", "--porcelain")).toContain("M a.txt");

    const g = clash();
    const head = git(g.work, "rev-parse", "HEAD");
    const err = await fastForward(g.at, none).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRefusal);
    expect(err).toMatchObject({ reason: "dirty" });
    expect((err as Error).message).toContain("a.txt");
    expect(git(g.work, "rev-parse", "HEAD")).toBe(head);
  });

  test("a submodule's path is read whole, spaces and all", () => {
    const sha = "a".repeat(40);
    expect(submodulePath(` ${sha} lib (heads/main)`)).toBe("lib");
    expect(submodulePath(`+${sha} my lib (v1.0-2-gabc)`)).toBe("my lib");
    expect(submodulePath(`-${sha} vendor/a b`)).toBe("vendor/a b");
  });

  // A submodule fixture is about 20 git spawns: 1.5 s at load 4, past 5 s at load 14.
  test("the submodules follow the commit the repo records, whatever submodule.recurse says", async () => {
    const f = withSubmodule();
    git(f.work, "config", "submodule.recurse", "true");
    const r = await fastForward(f.at, none);
    expect(r).toMatchObject({ result: "updated", commits: 1 });
    expect(r.submodules).toEqual({ moved: ["lib"], kept: [], error: null });
    expect(git(f.lib, "rev-parse", "HEAD")).toBe(f.recorded());
    // A submodule on another commit that the remote has is brought back, even with no new commits.
    git(f.lib, "checkout", "-q", "HEAD~1");
    expect((await fastForward(f.at, none)).submodules?.moved).toEqual(["lib"]);
    expect(git(f.lib, "rev-parse", "HEAD")).toBe(f.recorded());
  }, 20_000);

  // Two submodule fixtures of about 20 git spawns each: 2.4 s at load 4, past 5 s at load 14.
  test("a submodule with its own commits or changes is kept as it is, and the repo still moves", async () => {
    const f = withSubmodule();
    commit(f.lib, "local.txt");
    const mine = git(f.lib, "rev-parse", "HEAD");
    const r = await fastForward(f.at, none);
    expect(r.result).toBe("updated");
    expect(r.submodules).toEqual({
      moved: [],
      kept: [{ path: "lib", why: "tiene 1 commit sin subir" }],
      error: null,
    });
    expect(git(f.lib, "rev-parse", "HEAD")).toBe(mine);

    const g = withSubmodule();
    writeFileSync(join(g.lib, "one.txt"), "edited\n");
    expect((await fastForward(g.at, none)).submodules?.kept).toEqual([
      { path: "lib", why: "tiene cambios sin commitear" },
    ]);
  }, 20_000);

  test("a branch with its own commits is never merged", async () => {
    const { work, at } = behind();
    commit(work, "local.txt");
    const head = git(work, "rev-parse", "HEAD");
    expect(await refusal(fastForward(at, none))).toBe("diverged");
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
  });

  test("no upstream and a detached head have no branch to move", async () => {
    const f = fixture();
    git(f.work, "switch", "-q", "-c", "topic");
    expect(await refusal(fastForward(f.at, none))).toBe("no_upstream");
    git(f.work, "switch", "-q", "--detach", "main");
    expect(await refusal(fastForward(f.at, none))).toBe("detached");
  });

  test("a running terminal inside the checkout, also through a symlink, refuses it", async () => {
    const { work, at } = behind();
    const head = git(work, "rev-parse", "HEAD");
    mkdirSync(join(work, "src"));
    const link = join(dir, `link-${n}`);
    symlinkSync(work, link);
    for (const cwd of [work, join(work, "src"), join(link, "src")]) {
      expect(await refusal(fastForward(at, { list: () => [term(cwd)] }))).toBe("terminal_inside");
    }
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    // An ended terminal, or one in a sibling folder with the same prefix, is not inside.
    const sibling = `${work}-other`;
    mkdirSync(sibling);
    const outside = { list: () => [term(work, "exited"), term(sibling)] };
    expect((await fastForward(at, outside)).result).toBe("updated");
  });

  test("one write at a time per checkout", async () => {
    let release = () => {};
    const first = exclusive("/x", () => new Promise<void>((r) => (release = r)));
    expect(await refusal(exclusive("/x", async () => {}))).toBe("busy");
    await exclusive("/y", async () => {});
    release();
    await first;
    await exclusive("/x", async () => {});
  });
});

describe("update every repo", () => {
  test("one line per repo; a failed fetch or a refusal never stops the others", async () => {
    const ok = behind();
    const broken = behind();
    git(broken.work, "remote", "set-url", "origin", join(dir, "missing.git"));
    const dirty = clash();
    const plain = join(dir, `plain-${n}`);
    mkdirSync(plain);
    const config = ConfigSchema.parse({
      git: { bin: GIT },
      repos: [
        { id: "ok", localPath: ok.work },
        { id: "broken", localPath: broken.work },
        { id: "dirty", localPath: dirty.work },
        { id: "plain", localPath: plain },
      ],
    });
    const items = await updateRepos(config, { env: Promise.resolve(gitEnv), ...none });
    const by = Object.fromEntries(items.map((i) => [i.label, i]));
    expect(by.ok).toMatchObject({ location: "repo:ok", result: "updated", commits: 2 });
    expect(by.broken).toMatchObject({ result: "failed", reason: null });
    expect(by.broken?.detail).toContain("git exited with");
    expect(by.dirty).toMatchObject({ result: "skipped", reason: "dirty" });
    expect(by.plain).toMatchObject({ result: "skipped", reason: "not_a_repo" });
  });
});

describe("git write routes", () => {
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "content-type": "application/json",
  };
  const make = (repos: { id: string; localPath: string }[]) => {
    const config = ConfigSchema.parse({
      git: { bin: GIT },
      terminals: { shell: "/bin/sh" },
      repos,
    });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () => Promise.resolve(gitEnv));
    const app = createApp({ config, db, terminals, tokens: new AttachTokens() });
    return async (path: string, body: unknown) => {
      const res = await app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  };

  test("pull fast-forwards a repo; a refusal is a 409 with its reason and git's words stay", async () => {
    const f = behind();
    const g = clash();
    const post = make([
      { id: "f", localPath: f.work },
      { id: "g", localPath: g.work },
    ]);
    const ok = await post("/api/git/pull", { location: "repo:f" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ result: "updated", commits: 2 });
    const refused = await post("/api/git/pull", { location: "repo:g" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "refused", reason: "dirty" });
    expect(String(refused.body.detail)).toContain("se pisarían: a.txt");
  });

  test("env checkouts, unknown locations and bad bodies are refused before git runs", async () => {
    const post = make([]);
    const env = await post("/api/git/pull", { location: "env:x/backend" });
    expect(env).toMatchObject({ status: 409, body: { reason: "env_checkout" } });
    expect((await post("/api/git/pull", { location: "repo:nope" })).body.error).toBe(
      "launch_rejected",
    );
    expect((await post("/api/git/fetch", {})).status).toBe(400);
    expect((await post("/api/git/pull", null)).status).toBe(400);
  });

  test("fetch moves the remote refs only; update-all answers one line per repo", async () => {
    const { work, pusher } = behind();
    const head = git(work, "rev-parse", "HEAD");
    const post = make([{ id: "w", localPath: work }]);
    expect((await post("/api/git/fetch", { location: "repo:w" })).status).toBe(200);
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "rev-parse", "origin/main")).toBe(git(pusher, "rev-parse", "HEAD"));
    const all = await post("/api/git/update-all", {});
    expect(all.body.items).toEqual([
      {
        location: "repo:w",
        label: "w",
        result: "updated",
        reason: null,
        detail: null,
        commits: 2,
        submodules: null,
      },
    ]);
  });
});
