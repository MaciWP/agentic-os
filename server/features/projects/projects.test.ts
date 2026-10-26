import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { cached } from "../../cache.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { LaunchError } from "../terminals/harness.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { appNode, checkoutLink, type EnvCache, watchEnded } from "./routes.ts";
import { parsePorcelain, resolveWorktreeLocation, scanRepos } from "./worktrees.ts";

const GIT = "/usr/bin/git";

describe("git worktree porcelain", () => {
  test("reads branches, detached and bare records, and skips what the tree does not use", () => {
    const out = [
      "worktree /r/main",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /r/wt/feature",
      "HEAD bbb",
      "branch refs/heads/feature/x",
      "locked under review",
      "",
      "worktree /r/sub",
      "HEAD ccc",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /r/bare.git",
      "bare",
      "",
      "worktree /r/odd\nname",
      "HEAD ddd",
      "branch refs/heads/odd",
      "",
      "",
    ].join("\0");
    expect(parsePorcelain(out)).toEqual([
      { path: "/r/main", head: "aaa", branch: "main", detached: false, bare: false },
      { path: "/r/wt/feature", head: "bbb", branch: "feature/x", detached: false, bare: false },
      { path: "/r/sub", head: "ccc", branch: null, detached: true, bare: false },
      { path: "/r/bare.git", head: null, branch: null, detached: false, bare: true },
      { path: "/r/odd\nname", head: "ddd", branch: "odd", detached: false, bare: false },
    ]);
    expect(parsePorcelain("")).toEqual([]);
  });
});

// Real repos under a temp dir. Git reads no global or system config, so the user's hooks,
// signing and templates stay out, and HOME points inside the temp dir.
let dir: string;
let gitEnv: Record<string, string>;
let alpha: string;
let beta: string;
let root: string;
let envBin: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([GIT, ...args], { cwd, env: gitEnv, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

const initRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "README"), "x\n");
  git(path, "add", "README");
  git(path, "commit", "-q", "-m", "init");
};

beforeAll(() => {
  // Through tmpdir's symlink on macOS (/var → /private/var) on purpose: paths are compared real.
  dir = mkdtempSync(join(tmpdir(), "aos-projects-"));
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
  alpha = join(dir, "alpha");
  beta = join(dir, "beta");
  root = join(dir, "worktrees");
  initRepo(alpha);
  initRepo(beta);
  // alpha: a loose worktree, one nested in its own checkout, one detached, one inside an
  // env, and one whose directory is gone.
  git(alpha, "worktree", "add", "-q", "-b", "feature/x", join(dir, "loose", "alpha-x"));
  git(alpha, "worktree", "add", "-q", "-b", "inner", join(alpha, ".worktrees", "inner"));
  git(alpha, "worktree", "add", "-q", "--detach", join(dir, "loose", "alpha-detached"));
  git(alpha, "worktree", "add", "-q", "-b", "ABC-1", join(root, "env-a", "alpha-dir"));
  git(alpha, "worktree", "add", "-q", "-b", "gone", join(dir, "loose", "alpha-gone"));
  rmSync(join(dir, "loose", "alpha-gone"), { recursive: true });
  // beta: a worktree inside alpha's checkout, the way a submodule's worktree sits.
  git(beta, "worktree", "add", "-q", "--detach", join(alpha, "vendor-beta"));
  git(beta, "worktree", "add", "-q", "-b", "ABC-1", join(root, "env-a", "beta-dir"));
  mkdirSync(join(root, "env-a", "notes"), { recursive: true });
  // The profile names alpha through a symlink.
  symlinkSync(alpha, join(dir, "alpha-link"));

  // A fake env CLI: `list --json` and `proxy status --json` print fixtures and count calls.
  envBin = join(dir, "envcli");
  writeFileSync(
    join(dir, "list.json"),
    JSON.stringify([
      {
        env: "env-a",
        branch: "ABC-1",
        url: "https://env-a.example.invalid",
        repos: [
          { repo: "alpha", branch: "ABC-1", docker: "shared (2 up)", servers: "web" },
          { repo: "beta", branch: "ABC-1", docker: "—", servers: "stopped" },
        ],
      },
    ]),
  );
  writeFileSync(
    join(dir, "proxy.json"),
    JSON.stringify({
      up: true,
      hosts: ["env-a.example.invalid", "x-env-a.example.invalid", "env-b.example.invalid"],
      ca: true,
    }),
  );
  writeFileSync(
    envBin,
    `#!/bin/sh
if [ "$1" = list ]; then
  echo x >> "${dir}/calls"
  [ -f "${dir}/fail" ] && { echo "provider down" >&2; exit 3; }
  cat "${dir}/list.json"; exit 0
fi
if [ "$1" = proxy ]; then cat "${dir}/proxy.json"; exit 0; fi
exit 9
`,
  );
  chmodSync(envBin, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const profile = (extra: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    git: { bin: GIT },
    terminals: { shell: "/bin/sh" },
    repos: [
      { id: "alpha", localPath: join(dir, "alpha-link") },
      { id: "beta", localPath: beta },
      { id: "missing", localPath: join(dir, "nope") },
    ],
    envs: { bin: envBin, root, repos: ["alpha", "beta"], links: [{ repo: "beta", prefix: "x-" }] },
    ...extra,
  });

describe("repo worktrees", () => {
  test("main, loose and nested-in-own-repo stay; env, other-repo nested, gone ones do not", async () => {
    const real = realpathSync(dir);
    const { repos, envCheckouts } = await scanRepos(profile(), gitEnv);
    const [a, b, missing] = repos;
    expect(a?.main).toEqual({ path: join(real, "alpha"), branch: "main" });
    expect(a?.error).toBeNull();
    expect(a?.worktrees).toEqual([
      {
        path: join(real, "loose", "alpha-detached"),
        branch: null,
        head: expect.any(String),
        location: null,
      },
      {
        path: join(real, "loose", "alpha-x"),
        branch: "feature/x",
        head: expect.any(String),
        location: "wt:alpha:feature/x",
      },
      {
        path: join(real, "alpha", ".worktrees", "inner"),
        branch: "inner",
        head: expect.any(String),
        location: "wt:alpha:inner",
      },
    ]);
    // beta's worktree inside alpha's checkout belongs to alpha's place.
    expect(b?.worktrees).toEqual([]);
    expect(missing).toMatchObject({
      id: "missing",
      main: null,
      error: expect.stringContaining("does not exist"),
    });
    expect(envCheckouts.get(join(real, "worktrees", "env-a", "alpha-dir"))).toEqual({
      repo: "alpha",
      branch: "ABC-1",
    });
    expect(envCheckouts.get(join(real, "worktrees", "env-a", "beta-dir"))?.repo).toBe("beta");
  });

  test("a repo git refuses carries its own error; the profile without git says so", async () => {
    const notRepo = join(dir, "plain");
    mkdirSync(notRepo, { recursive: true });
    const config = profile({ repos: [{ id: "plain", localPath: notRepo }] });
    const [plain] = (await scanRepos(config, gitEnv)).repos;
    expect(plain?.error).toContain("git exited with");
    const noGit = { ...config, git: { ...config.git, bin: undefined } };
    expect((await scanRepos(noGit, gitEnv)).repos[0]?.error).toContain("git.bin");
  });

  test("wt: locations resolve only to a loose worktree on that branch", async () => {
    const config = profile();
    const real = realpathSync(dir);
    expect(await resolveWorktreeLocation(config, gitEnv, "wt:alpha:feature/x")).toEqual({
      id: "wt:alpha:feature/x",
      label: "alpha/feature/x",
      cwd: join(real, "loose", "alpha-x"),
    });
    for (const id of [
      "wt:alpha:ABC-1", // inside an env: launched as env:<name>/<dir>
      "wt:alpha:main", // the main checkout is repo:<id>
      "wt:alpha:nope",
      "wt:alpha:gone",
      "wt:other:feature/x",
      "wt:alpha:",
      "wt::main",
      "wt:alpha",
      "wt:alpha:../../etc",
    ]) {
      await expect(resolveWorktreeLocation(config, gitEnv, id)).rejects.toBeInstanceOf(LaunchError);
    }
  });

  test("a terminal starts in the worktree a wt: location names", async () => {
    const config = profile();
    const terminals = new TerminalManager(config, openDb(":memory:"), () =>
      Promise.resolve(gitEnv),
    );
    const t = await terminals.create({ harness: "shell", location: "wt:alpha:inner" });
    try {
      expect(t.cwd).toBe(join(realpathSync(dir), "alpha", ".worktrees", "inner"));
      expect(t.location).toBe("wt:alpha:inner");
    } finally {
      await terminals.stop(t.id);
    }
    await expect(terminals.create({ harness: "shell", location: "wt:alpha:nope" })).rejects.toThrow(
      "no worktree on nope",
    );
  });
});

describe("projects route", () => {
  const make = (config = profile()) => {
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () => Promise.resolve(gitEnv));
    return createApp({ config, db, terminals, tokens: new AttachTokens() });
  };
  const calls = () => readFileSync(join(dir, "calls"), "utf8").split("\n").length - 1;
  type Body = {
    envs: {
      configured: boolean;
      error: string | null;
      proxy: { up: boolean } | null;
      repos: string[];
      items: {
        name: string;
        hosts: string[];
        repos: { repo: string; docker: string | null; servers: string | null }[];
        checkouts: {
          dir: string;
          location: string;
          repo: string | null;
          branch: string | null;
          link: string | null;
        }[];
      }[];
    };
    repos: { id: string; location: string; error: string | null }[];
    app: { location: string };
  };
  const get = async (app: ReturnType<typeof make>, query = "") =>
    (await (
      await app.request(`/api/projects${query}`, { headers: { host: "127.0.0.1:4317" } })
    ).json()) as Body;

  test("envs with their checkouts from git, repos, and the app; the env list is read once", async () => {
    rmSync(join(dir, "calls"), { force: true });
    const app = make();
    const body = await get(app);
    const [envA] = body.envs.items;
    expect(envA?.checkouts).toEqual([
      {
        dir: "alpha-dir",
        location: "env:env-a/alpha-dir",
        repo: "alpha",
        branch: "ABC-1",
        link: null,
      },
      // The config's rule hangs the `x-` host from beta's checkout.
      {
        dir: "beta-dir",
        location: "env:env-a/beta-dir",
        repo: "beta",
        branch: "ABC-1",
        link: "https://x-env-a.example.invalid",
      },
    ]);
    expect(envA?.hosts).toEqual(["env-a.example.invalid", "x-env-a.example.invalid"]);
    expect(envA?.repos[1]).toMatchObject({ repo: "beta", docker: null, servers: "stopped" });
    expect(body.envs.proxy).toMatchObject({ up: true });
    // What "Nuevo entorno" offers to check out.
    expect(body.envs.repos).toEqual(["alpha", "beta"]);
    expect(body.repos.map((r) => [r.id, r.location])).toEqual([
      ["alpha", "repo:alpha"],
      ["beta", "repo:beta"],
      ["missing", "repo:missing"],
    ]);
    expect(body.app.location).toBe("app");
    await get(app);
    expect(calls()).toBe(1);
    await get(app, "?fresh=1");
    expect(calls()).toBe(2);
  });

  test("a failing env provider stays on the envs group and is not cached", async () => {
    const app = make();
    writeFileSync(join(dir, "fail"), "");
    try {
      const body = await get(app);
      expect(body.envs).toMatchObject({
        configured: true,
        items: [],
        error: expect.stringContaining("provider down"),
      });
      expect(body.repos[0]?.error).toBeNull();
    } finally {
      rmSync(join(dir, "fail"));
    }
    expect((await get(app)).envs.items.map((e) => e.name)).toEqual(["env-a"]);
  });

  test("a missing env root is the envs group's error, not a failed route", async () => {
    const config = profile();
    const envs = config.envs && { ...config.envs, root: join(dir, "no-root") };
    const body = await get(make({ ...config, envs }));
    expect(body.envs.error).toContain("does not exist");
    expect(body.repos[0]?.error).toBeNull();
  });

  test("without an env provider the envs group says so", async () => {
    const config = profile();
    const body = await get(make({ ...config, envs: undefined }));
    expect(body.envs).toEqual({
      configured: false,
      items: [],
      proxy: null,
      error: null,
      repos: [],
    });
  });
});

describe("checkout link", () => {
  const links = [{ repo: "web", prefix: "tenant-" }];
  const hosts = ["env-a.test", "tenant-env-a.test", "tenant-env-ab.test"];
  test("the host a rule names for the checkout's repo, as https", () => {
    expect(checkoutLink(links, hosts, "env-a", "web")).toBe("https://tenant-env-a.test");
  });
  test("none without a rule for the repo, or without its host", () => {
    expect(checkoutLink(links, hosts, "env-a", "api")).toBeNull();
    expect(checkoutLink(links, hosts, "env-a", null)).toBeNull();
    expect(checkoutLink(links, ["env-a.test"], "env-a", "web")).toBeNull();
  });
  test("a host that is not plain never becomes an href", () => {
    expect(checkoutLink(links, ["tenant-env-a.x/y"], "env-a", "web")).toBeNull();
    expect(checkoutLink(links, ["tenant-env-a.bad host"], "env-a", "web")).toBeNull();
  });
});

describe("env cache", () => {
  test("one load at a time; a load invalidated on the way never fills the cache", async () => {
    let n = 0;
    let release = () => {};
    const cache: EnvCache = cached(
      () =>
        new Promise((resolve) => {
          n++;
          release = () => resolve({ envs: [], proxy: { up: n > 1, hosts: [] } });
        }),
    );
    const first = cache.get();
    expect(cache.get()).toBe(first);
    cache.invalidate();
    release();
    await first;
    const second = cache.get();
    release();
    expect((await second).proxy?.up).toBe(true);
    expect(n).toBe(2);
    await cache.get();
    expect(n).toBe(2);
  });

  test("an ended terminal tells the tree; an ended env command also drops the env list", async () => {
    const info = (id: string, harness: TerminalInfo["harness"], state: TerminalInfo["state"]) =>
      ({ id, harness, state }) as TerminalInfo;
    let list: TerminalInfo[] = [info("a", "shell", "running")];
    let invalidated = 0;
    let published = 0;
    const order: string[] = [];
    const cache = {
      invalidate: () => invalidated++,
      get: async () => order.push(`read after ${published}`),
    } as unknown as EnvCache;
    const terminals = { list: () => list } as unknown as Terminals;
    const changed = watchEnded(terminals, cache, () => published++);
    await changed();
    expect([published, invalidated]).toEqual([0, 0]);
    list = [info("a", "shell", "exited")];
    await changed();
    await changed();
    expect([published, invalidated]).toEqual([1, 0]);
    list = [info("a", "shell", "exited"), info("b", "env", "exited")];
    await changed();
    expect([published, invalidated]).toEqual([2, 1]);
    // The env list is read again before the tree is told, so the tree never reads it cold.
    expect(order).toEqual(["read after 1"]);
  });
});

describe("the app's own node", () => {
  test("is the repo whose folder is the app's, through a link too; else the app's folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aos-app-")));
    try {
      mkdirSync(join(root, "app"));
      symlinkSync(join(root, "app"), join(root, "link"));
      const config = (repos: { id: string; localPath: string }[]) =>
        ConfigSchema.parse({ port: 4317, repos });
      expect(await appNode(config([]), join(root, "app"))).toEqual({
        location: "app",
        label: "Agentic OS",
      });
      const repos = [
        { id: "other", localPath: join(root, "missing") },
        { id: "agentic-os", localPath: join(root, "link") },
      ];
      expect(await appNode(config(repos), join(root, "app"))).toEqual({
        location: "repo:agentic-os",
        label: "agentic-os",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
