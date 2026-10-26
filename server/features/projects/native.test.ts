import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { GitRefusal } from "../git/sync.ts";
import type { TerminalInfo, TerminalState } from "../terminals/contract.ts";
import { LaunchError } from "../terminals/harness.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { addWorktree, listBranches, removeWorktree, slugOf, worktreeRoot } from "./native.ts";
import { resolveWorktreeLocation } from "./worktrees.ts";

const GIT = "/usr/bin/git";

let dir: string;
let gitEnv: Record<string, string>;
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([GIT, ...args], { cwd, env: gitEnv, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const commit = (cwd: string, file: string, text = `${file}\n`) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
};

// A bare origin, the repo's main checkout with `.env` ignored, a clone that pushes, and an
// empty worktree root beside them.
function fixture() {
  const base = join(dir, `case-${++n}`);
  mkdirSync(base);
  const origin = join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const work = join(base, "work");
  git(base, "clone", "-q", origin, work);
  commit(work, ".gitignore", ".env\n");
  commit(work, "a.txt");
  git(work, "push", "-q", "-u", "origin", "main");
  // A clone of an empty origin has no origin/HEAD; most real clones do.
  git(work, "remote", "set-head", "origin", "main");
  const pusher = join(base, "pusher");
  git(base, "clone", "-q", origin, pusher);
  const root = join(base, "trees");
  mkdirSync(root);
  const config = ConfigSchema.parse({
    git: { bin: GIT },
    repos: [{ id: "alpha", localPath: work }],
    worktrees: { root },
  });
  return { base, work, pusher, root, config };
}

const term = (cwd: string, state: TerminalState = "running") => ({ cwd, state }) as TerminalInfo;
const terminals = (list: TerminalInfo[] = []) => ({
  env: Promise.resolve(gitEnv),
  list: () => list,
});
const reasonOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GitRefusal);
  return (err as GitRefusal).reason;
};
const upstreamOf = (cwd: string) =>
  Bun.spawnSync([GIT, "rev-parse", "--abbrev-ref", "@{upstream}"], { cwd, env: gitEnv })
    .exitCode === 0
    ? git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}")
    : null;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-native-")));
  gitEnv = {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
});
// Removing the test repos took 23 s at load 37 (native, 2026-10-08), after every test had
// passed; Bun gives a hook 5 s. The cleanup gets the time it needs.
afterAll(() => rmSync(dir, { recursive: true, force: true }), 60_000);

describe("adding a worktree", () => {
  test("a new branch starts from the remote's default branch after a fetch, with no upstream", async () => {
    const f = fixture();
    commit(f.pusher, "b.txt");
    git(f.pusher, "push", "-q");
    const r = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "feat/one" });
    expect(r).toEqual({
      location: "wt:alpha:feat/one",
      path: join(f.root, "alpha", "feat-one"),
      branch: "feat/one",
      mode: "new",
      base: "refs/remotes/origin/main",
      fetchError: null,
    });
    // The fetch ran first: the new branch has the commit the main checkout has not pulled.
    expect(git(r.path, "rev-parse", "HEAD")).toBe(git(f.pusher, "rev-parse", "HEAD"));
    expect(git(r.path, "branch", "--show-current")).toBe("feat/one");
    expect(upstreamOf(r.path)).toBeNull();
    expect((await resolveWorktreeLocation(f.config, gitEnv, r.location)).cwd).toBe(r.path);
  });

  // git 2.48+ fetch recreates origin/HEAD by itself (followRemoteHEAD), so the picker, which
  // never fetches, is where the fallback shows; the app itself never sets it.
  test("without origin/HEAD the default branch is asked to the remote, and never set", async () => {
    const f = fixture();
    git(f.work, "remote", "set-head", "origin", "-d");
    expect((await listBranches(f.config, gitEnv, "alpha")).base).toBe("refs/remotes/origin/main");
    expect(
      Bun.spawnSync([GIT, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"], {
        cwd: f.work,
        env: gitEnv,
      }).exitCode,
    ).toBe(1);
    // No origin/HEAD and no remote to ask: a base must be picked.
    git(f.work, "remote", "set-url", "origin", join(dir, "missing.git"));
    expect(await reasonOf(addWorktree(f.config, gitEnv, { repo: "alpha", branch: "two" }))).toBe(
      "bad_base",
    );
  });

  test("an existing local branch opens as it is; a remote one becomes a tracking branch", async () => {
    const f = fixture();
    git(f.work, "branch", "mine");
    commit(f.pusher, "b.txt");
    git(f.pusher, "push", "-q");
    const mine = git(f.work, "rev-parse", "mine");
    const local = await addWorktree(f.config, gitEnv, {
      repo: "alpha",
      branch: "mine",
      base: "refs/heads/nope",
    });
    expect(local).toMatchObject({ mode: "local", base: null });
    expect(git(local.path, "branch", "--show-current")).toBe("mine");
    expect(git(local.path, "rev-parse", "HEAD")).toBe(mine);

    git(f.pusher, "switch", "-q", "-c", "pushed");
    commit(f.pusher, "c.txt");
    git(f.pusher, "push", "-q", "-u", "origin", "pushed");
    const remote = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "pushed" });
    expect(remote).toMatchObject({ mode: "remote", base: "refs/remotes/origin/pushed" });
    expect(upstreamOf(remote.path)).toBe("origin/pushed");
    expect(git(remote.path, "rev-parse", "HEAD")).toBe(git(f.pusher, "rev-parse", "HEAD"));
  });

  test("an explicit base must be a local or remote branch that exists", async () => {
    const f = fixture();
    git(f.work, "switch", "-q", "-c", "topic");
    commit(f.work, "t.txt");
    git(f.work, "switch", "-q", "main");
    const r = await addWorktree(f.config, gitEnv, {
      repo: "alpha",
      branch: "off-topic",
      base: "refs/heads/topic",
    });
    expect(git(r.path, "rev-parse", "HEAD")).toBe(git(f.work, "rev-parse", "topic"));
    for (const base of [
      "refs/heads/missing",
      "topic",
      "HEAD",
      "--upload-pack=x",
      "refs/remotes/origin/HEAD",
      "refs/tags/v1",
    ]) {
      expect(
        await reasonOf(addWorktree(f.config, gitEnv, { repo: "alpha", branch: "x", base })),
      ).toBe("bad_base");
    }
    expect(existsSync(join(f.root, "alpha", "x"))).toBe(false);
  });

  test("names git rejects, or that it would expand, are refused before anything runs", async () => {
    const f = fixture();
    git(f.work, "switch", "-q", "-c", "other");
    git(f.work, "switch", "-q", "main");
    for (const branch of [
      "-x",
      "a..b",
      "a b",
      "HEAD",
      "x.lock",
      "a~1",
      ".x",
      "@{-1}",
      "-",
      "x".repeat(201),
      "...",
    ]) {
      expect(await reasonOf(addWorktree(f.config, gitEnv, { repo: "alpha", branch }))).toBe(
        "bad_branch",
      );
    }
    expect(git(f.work, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test("a branch checked out elsewhere is git's refusal, in its words", async () => {
    const f = fixture();
    const err = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "main" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitRefusal);
    expect((err as GitRefusal).reason).toBe("in_use");
    expect((err as GitRefusal).message).toContain("'main' is already used by worktree");
  });

  test("two branches with the same folder name, or a taken folder, are refused", async () => {
    const f = fixture();
    await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "feat/x" });
    expect(await reasonOf(addWorktree(f.config, gitEnv, { repo: "alpha", branch: "feat-x" }))).toBe(
      "exists",
    );
    writeFileSync(join(f.root, "alpha", "taken"), "");
    expect(await reasonOf(addWorktree(f.config, gitEnv, { repo: "alpha", branch: "taken" }))).toBe(
      "exists",
    );
    expect(git(f.work, "branch", "--list", "feat-x", "taken")).toBe("");
  });

  test("a repo folder that is a link never takes a worktree", async () => {
    const f = fixture();
    const elsewhere = join(f.base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(f.root, "alpha"));
    expect(await reasonOf(addWorktree(f.config, gitEnv, { repo: "alpha", branch: "y" }))).toBe(
      "no_root",
    );
    expect(existsSync(join(elsewhere, "y"))).toBe(false);
  });

  test("a failed fetch does not stop it: it starts from what the clone has, and says so", async () => {
    const f = fixture();
    git(f.work, "remote", "set-url", "origin", join(dir, "missing.git"));
    const r = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "offline" });
    expect(r.mode).toBe("new");
    expect(r.fetchError).toContain("git exited with");
  });

  test("unknown repos and repo ids that are not one folder are bad locations", async () => {
    const f = fixture();
    for (const repo of ["nope", "..", "a/b"]) {
      await expect(addWorktree(f.config, gitEnv, { repo, branch: "z" })).rejects.toBeInstanceOf(
        LaunchError,
      );
    }
  });

  test("the slug keeps safe characters only and never starts with a dot or dash", () => {
    expect(slugOf("feat/ABC-12_x.y")).toBe("feat-ABC-12_x.y");
    expect(slugOf("ñ")).toBe("");
  });
});

describe("the worktree root", () => {
  test("missing, absent or overlapping a checkout or the envs root: refused with the reason", async () => {
    const f = fixture();
    const parse = (extra: object) =>
      ConfigSchema.parse({
        git: { bin: GIT },
        repos: [{ id: "alpha", localPath: f.work }],
        ...extra,
      });
    expect((await worktreeRoot(parse({}))).error).toContain("no tiene worktrees.root");
    expect(
      (await worktreeRoot(parse({ worktrees: { root: join(f.base, "gone") } }))).error,
    ).toContain("no existe");
    mkdirSync(join(f.work, "trees"));
    expect(
      (await worktreeRoot(parse({ worktrees: { root: join(f.work, "trees") } }))).error,
    ).toContain("alpha");
    expect((await worktreeRoot(parse({ worktrees: { root: f.base } }))).error).toContain("alpha");
    const envs = { bin: "/bin/echo", root: f.root, repos: ["backend"] };
    expect((await worktreeRoot(parse({ envs, worktrees: { root: f.root } }))).error).toContain(
      "entornos",
    );
    expect(await reasonOf(addWorktree(parse({}), gitEnv, { repo: "alpha", branch: "z" }))).toBe(
      "no_root",
    );
    expect(await worktreeRoot(f.config)).toEqual({ root: f.root, error: null });
  });

  test("branches for the picker: local and remote refnames and the default base", async () => {
    const f = fixture();
    git(f.work, "branch", "mine");
    const b = await listBranches(f.config, gitEnv, "alpha");
    expect(b.local.sort()).toEqual(["refs/heads/main", "refs/heads/mine"]);
    expect(b.remote).toEqual(["refs/remotes/origin/main"]);
    expect(b.base).toBe("refs/remotes/origin/main");
  });
});

describe("removing a worktree", () => {
  test("a clean one goes; its branch stays", async () => {
    const f = fixture();
    const r = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "done" });
    commit(r.path, "d.txt");
    const head = git(r.path, "rev-parse", "HEAD");
    expect(await removeWorktree(f.config, terminals(), { location: r.location })).toEqual({
      location: r.location,
      path: r.path,
      branch: "done",
    });
    expect(existsSync(r.path)).toBe(false);
    expect(git(f.work, "rev-parse", "refs/heads/done")).toBe(head);
  });

  test("changed or untracked files are git's refusal; nothing is deleted", async () => {
    const f = fixture();
    const r = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "dirty" });
    writeFileSync(join(r.path, "new.txt"), "mine\n");
    const err = await removeWorktree(f.config, terminals(), {
      location: r.location,
      dropIgnored: true,
    }).catch((e: unknown) => e);
    expect((err as GitRefusal).reason).toBe("dirty");
    expect((err as GitRefusal).message).toContain("contains modified or untracked files");
    expect(existsSync(join(r.path, "new.txt"))).toBe(true);
  });

  test("ignored files are listed and kept unless the user drops them", async () => {
    const f = fixture();
    const r = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "env" });
    writeFileSync(join(r.path, ".env"), "SECRET=x\n");
    const err = await removeWorktree(f.config, terminals(), { location: r.location }).catch(
      (e: unknown) => e,
    );
    expect((err as GitRefusal).reason).toBe("ignored");
    expect((err as GitRefusal).message).toContain(".env");
    expect(existsSync(join(r.path, ".env"))).toBe(true);
    await removeWorktree(f.config, terminals(), { location: r.location, dropIgnored: true });
    expect(existsSync(r.path)).toBe(false);
  });

  test("a running terminal inside stops it; an ended one does not", async () => {
    const f = fixture();
    const r = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "busy" });
    mkdirSync(join(r.path, "src"));
    expect(
      await reasonOf(
        removeWorktree(f.config, terminals([term(join(r.path, "src"))]), { location: r.location }),
      ),
    ).toBe("terminal_inside");
    expect(existsSync(r.path)).toBe(true);
    await removeWorktree(f.config, terminals([term(r.path, "exited")]), { location: r.location });
    expect(existsSync(r.path)).toBe(false);
  });

  test("initialized submodules are refused with the reason; the app never forces", async () => {
    const f = fixture();
    const sub = join(f.base, "sub");
    git(f.base, "init", "-q", "-b", "main", sub);
    commit(sub, "s.txt");
    const r = await addWorktree(f.config, gitEnv, { repo: "alpha", branch: "with-sub" });
    git(r.path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "s");
    git(r.path, "commit", "-q", "-m", "sub");
    expect(await reasonOf(removeWorktree(f.config, terminals(), { location: r.location }))).toBe(
      "submodules",
    );
    expect(existsSync(join(r.path, "s", "s.txt"))).toBe(true);
  });

  test("worktrees the app did not make, the main checkout and unknown ids are not removed", async () => {
    const f = fixture();
    const outside = join(f.base, "by-hand");
    git(f.work, "worktree", "add", "-q", "-b", "by-hand", outside);
    expect(
      await reasonOf(removeWorktree(f.config, terminals(), { location: "wt:alpha:by-hand" })),
    ).toBe("not_app_worktree");
    expect(existsSync(outside)).toBe(true);
    for (const location of ["wt:alpha:main", "wt:alpha:nope", "repo:alpha", "wt:nope:x"]) {
      await expect(removeWorktree(f.config, terminals(), { location })).rejects.toBeInstanceOf(
        LaunchError,
      );
    }
  });
});

describe("worktree routes", () => {
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "content-type": "application/json",
  };
  const make = (config: ReturnType<typeof fixture>["config"]) => {
    const db = openDb(":memory:");
    const manager = new TerminalManager(config, db, () => Promise.resolve(gitEnv));
    const app = createApp({ config, db, terminals: manager, tokens: new AttachTokens() });
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  };

  test("add, list as removable, refuse a second, remove; bad bodies are 400", async () => {
    const f = fixture();
    const call = make(f.config);
    const added = await call("POST", "/api/projects/worktrees", {
      repo: "alpha",
      branch: "feat/r",
    });
    expect(added).toMatchObject({
      status: 200,
      body: { location: "wt:alpha:feat/r", mode: "new" },
    });

    const tree = await call("GET", "/api/projects");
    const repo = (
      tree.body.repos as { id: string; worktrees: { location: string; removable: boolean }[] }[]
    )[0];
    expect(repo?.worktrees).toEqual([
      expect.objectContaining({ location: "wt:alpha:feat/r", removable: true }),
    ]);
    expect(tree.body.worktrees).toEqual({ configured: true, error: null });

    const again = await call("POST", "/api/projects/worktrees", {
      repo: "alpha",
      branch: "feat/r",
    });
    expect(again).toMatchObject({ status: 409, body: { error: "refused", reason: "exists" } });
    expect(
      (await call("POST", "/api/projects/worktrees", { repo: "alpha", branch: "-x" })).body.reason,
    ).toBe("bad_branch");
    expect(
      (await call("POST", "/api/projects/worktrees", { repo: "nope", branch: "x" })).status,
    ).toBe(400);
    expect((await call("POST", "/api/projects/worktrees", { branch: "x" })).status).toBe(400);

    const branches = await call("GET", "/api/projects/repos/alpha/branches");
    expect(branches.body.base).toBe("refs/remotes/origin/main");
    expect(branches.body.local).toContain("refs/heads/feat/r");

    const removed = await call("DELETE", "/api/projects/worktrees", {
      location: "wt:alpha:feat/r",
    });
    expect(removed).toMatchObject({ status: 200, body: { branch: "feat/r" } });
    expect(
      (await call("DELETE", "/api/projects/worktrees", { location: "wt:alpha:feat/r" })).status,
    ).toBe(400);
    expect((await call("DELETE", "/api/projects/worktrees", null)).status).toBe(400);
  });

  test("without a root the tree says why and adding is refused", async () => {
    const f = fixture();
    const config = ConfigSchema.parse({
      git: { bin: GIT },
      repos: [{ id: "alpha", localPath: f.work }],
    });
    const call = make(config);
    expect((await call("GET", "/api/projects")).body.worktrees).toEqual({
      configured: false,
      error: "El perfil no tiene worktrees.root.",
    });
    expect(
      await call("POST", "/api/projects/worktrees", { repo: "alpha", branch: "x" }),
    ).toMatchObject({
      status: 409,
      body: { reason: "no_root" },
    });
  });
});
