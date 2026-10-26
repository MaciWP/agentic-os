import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { GitError, GitTimeout, runGit } from "./run.ts";
import {
  type GitStatus,
  isRepoRoot,
  nullFile,
  parseStatus,
  readDiff,
  readStatus,
} from "./status.ts";

const GIT = "/usr/bin/git";

describe("porcelain v2 status", () => {
  test("headers, changed, renamed, conflict and untracked records, paths with spaces", () => {
    const out = [
      "# branch.oid 0123abcd",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaa aaa src/a b.ts",
      "1 A. N... 000000 100644 100644 000 bbb new.ts",
      "2 R. N... 100644 100644 100644 ccc ccc R100 to name.ts",
      "from name.ts",
      "u UU N... 100644 100644 100644 100644 d1 d2 d3 both.ts",
      "? dir/untracked file",
      "",
    ].join("\0");
    expect(parseStatus(out)).toEqual({
      repo: true,
      branch: "feature/x",
      oid: "0123abcd",
      upstream: "origin/feature/x",
      ahead: 2,
      behind: 3,
      truncated: false,
      files: [
        { path: "src/a b.ts", orig: null, x: ".", y: "M", kind: "changed" },
        { path: "new.ts", orig: null, x: "A", y: ".", kind: "changed" },
        { path: "to name.ts", orig: "from name.ts", x: "R", y: ".", kind: "renamed" },
        { path: "both.ts", orig: null, x: "U", y: "U", kind: "conflict" },
        { path: "dir/untracked file", orig: null, x: "?", y: "?", kind: "untracked" },
      ],
    });
  });

  test("a new repo and a detached head have no branch; no upstream means no counts", () => {
    const s = parseStatus("# branch.oid (initial)\0# branch.head (detached)\0");
    expect(s).toMatchObject({ branch: null, oid: null, upstream: null, ahead: null, behind: null });
  });

  test("a truncated output drops the cut record, and a rename cut before its origin", () => {
    const whole = "1 .M N... 100644 100644 100644 a a one.ts\0";
    expect(parseStatus(`${whole}1 .M N... 100644 1`, true).files.map((f) => f.path)).toEqual([
      "one.ts",
    ]);
    const cut = `${whole}2 R. N... 100644 100644 100644 c c R100 new.ts\0old`;
    const s = parseStatus(cut, true);
    expect(s.files.map((f) => f.path)).toEqual(["one.ts"]);
    expect(s.truncated).toBe(true);
  });

  test("past the file cap the list stops and says so", () => {
    const out = `${Array.from({ length: 2001 }, (_, i) => `? f${i}`).join("\0")}\0`;
    const s = parseStatus(out);
    expect(s.files).toHaveLength(2000);
    expect(s.truncated).toBe(true);
  });
});

let dir: string;
let work: string;
let gitEnv: Record<string, string>;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([GIT, ...args], { cwd, env: gitEnv, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-git-")));
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
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  work = join(dir, "work");
  git(dir, "clone", "-q", origin, work);
  writeFileSync(join(work, "a.txt"), "one\ntwo\n");
  writeFileSync(join(work, "old name.txt"), "moved\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "-u", "origin", "main");
  // One commit ahead of origin, and origin one ahead of us through a second clone.
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", "b.txt");
  git(work, "commit", "-q", "-m", "local");
  const other = join(dir, "other");
  git(dir, "clone", "-q", origin, other);
  writeFileSync(join(other, "c.txt"), "c\n");
  git(other, "add", "c.txt");
  git(other, "commit", "-q", "-m", "remote");
  git(other, "push", "-q");
  git(work, "fetch", "-q");
  // The working state: modified, staged, renamed, untracked in a new directory.
  writeFileSync(join(work, "a.txt"), "one\nTWO\n");
  writeFileSync(join(work, "staged.txt"), "staged\n");
  git(work, "add", "staged.txt");
  git(work, "mv", "old name.txt", "new name.txt");
  mkdirSync(join(work, "fresh", "deep"), { recursive: true });
  writeFileSync(join(work, "fresh", "deep", "x.txt"), "hello\n");
});
// Removing the test repos took 23 s at load 37 (native, 2026-10-08), after every test had
// passed; Bun gives a hook 5 s. The cleanup gets the time it needs.
afterAll(() => rmSync(dir, { recursive: true, force: true }), 60_000);

describe("git runner", () => {
  test("never prompts and never takes optional locks; the caller's env is kept", async () => {
    const { out } = await runGit("/usr/bin/env", dir, [], { env: { KEEP: "1" } });
    expect(out.split("\n")).toEqual(
      expect.arrayContaining(["KEEP=1", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0"]),
    );
  });

  test("past the byte cap the process is killed and the output comes back truncated", async () => {
    const r = await runGit("/usr/bin/yes", dir, [], { env: {}, maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.out).toHaveLength(1000);
  });

  test("a call cut at its deadline is a GitTimeout, so the summary can name the slow checkout", async () => {
    const late = runGit("/bin/sleep", dir, ["5"], { env: {}, timeoutMs: 50 });
    await expect(late).rejects.toBeInstanceOf(GitTimeout);
    await expect(late).rejects.toThrow(/timed out after 50 ms/);
  });

  test("an exit code outside `ok` is an error with git's own words; inside it is not", async () => {
    await expect(runGit(GIT, dir, ["rev-parse", "HEAD"], { env: gitEnv })).rejects.toThrow(
      /git exited with 128: .*not a git repository/,
    );
    await expect(runGit("/usr/bin/false", dir, [], { env: {} })).rejects.toBeInstanceOf(GitError);
    expect((await runGit("/usr/bin/false", dir, [], { env: {}, ok: [0, 1] })).code).toBe(1);
  });

  test("a call past its timeout ends at the deadline, even while a child holds the pipes", async () => {
    const slow = join(dir, "slow");
    writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
    chmodSync(slow, 0o755);
    const started = Date.now();
    await expect(runGit(slow, dir, [], { env: {}, timeoutMs: 100 })).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a timed-out call leaves no child behind", async () => {
    const spawner = join(dir, "spawner");
    const pidFile = join(dir, "spawner.pid");
    writeFileSync(spawner, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
    chmodSync(spawner, 0o755);
    await expect(runGit(spawner, dir, [], { env: {}, timeoutMs: 300 })).rejects.toThrow(
      "timed out",
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(50);
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid, "SIGKILL");
    }
  });
});

describe("status and diff on a real checkout", () => {
  const at = () => ({ bin: GIT, cwd: work, env: gitEnv });

  test("branch, upstream, ahead/behind and every kind of change", async () => {
    const s = await readStatus(at());
    expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 1, behind: 1 });
    const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]));
    expect(byPath["a.txt"]).toMatchObject({ x: ".", y: "M", kind: "changed" });
    expect(byPath["staged.txt"]).toMatchObject({ x: "A", y: ".", kind: "changed" });
    expect(byPath["new name.txt"]).toMatchObject({ orig: "old name.txt", kind: "renamed" });
    // --untracked-files=all: the files of a new directory, not the directory.
    expect(byPath["fresh/deep/x.txt"]).toMatchObject({ kind: "untracked" });
    expect(s.files).toHaveLength(4);
  });

  test("a clean checkout lists nothing", async () => {
    const clean = join(dir, "other");
    expect((await readStatus({ ...at(), cwd: clean })).files).toEqual([]);
  });

  test("diffs: unstaged, staged, a staged rename with both paths, an untracked file", async () => {
    const s = await readStatus(at());
    const file = (p: string) => s.files.find((f) => f.path === p) as GitStatus["files"][number];
    expect((await readDiff(at(), file("a.txt"), false)).diff).toContain("-two\n+TWO");
    expect((await readDiff(at(), file("staged.txt"), true)).diff).toContain("+staged");
    expect((await readDiff(at(), file("staged.txt"), false)).diff).toBe("");
    const renamed = (await readDiff(at(), file("new name.txt"), true)).diff;
    expect(renamed).toContain("rename from old name.txt");
    expect(renamed).toContain("rename to new name.txt");
    const fresh = await readDiff(at(), file("fresh/deep/x.txt"), false);
    expect(fresh.diff).toContain("+hello");
    expect(fresh.truncated).toBe(false);
  });

  // `diff --no-index` exits 1 both on a difference and on an error; an error is never an
  // empty diff (Git for Windows read /dev/null as a folder and every new file showed nothing).
  test("an untracked file gone before its diff is an error, not an empty diff", async () => {
    const gone = { path: "vanished.txt", orig: null, x: "?", y: "?", kind: "untracked" as const };
    await expect(readDiff(at(), gone, false)).rejects.toThrow(GitError);
  });

  test("the empty side of a new file is the null device git accepts on each platform", () => {
    expect(nullFile("darwin")).toBe("/dev/null");
    expect(nullFile("win32")).toBe("nul");
  });

  test("only a checkout's own top level is a repo", async () => {
    expect(await isRepoRoot(at())).toBe(true);
    expect(await isRepoRoot({ ...at(), cwd: join(work, "fresh") })).toBe(false);
    expect(await isRepoRoot({ ...at(), cwd: dir })).toBe(false);
  });
});

describe("git routes", () => {
  const make = () => {
    const config = ConfigSchema.parse({
      git: { bin: GIT },
      terminals: { shell: "/bin/sh" },
      repos: [
        { id: "work", localPath: work },
        { id: "inner", localPath: join(work, "fresh") },
      ],
    });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () => Promise.resolve(gitEnv));
    return createApp({ config, db, terminals, tokens: new AttachTokens() });
  };
  const get = async (path: string) => {
    const res = await make().request(path, { headers: { host: "127.0.0.1:4317" } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const q = encodeURIComponent;

  test("status of a repo location; a subdirectory of a checkout is not a repo", async () => {
    const { status, body } = await get("/api/git/status?location=repo:work");
    expect(status).toBe(200);
    expect(body).toMatchObject({ repo: true, branch: "main", ahead: 1, behind: 1 });
    expect((await get("/api/git/status?location=repo:inner")).body).toEqual({ repo: false });
  });

  test("a diff only for a file git lists now; unknown locations are refused", async () => {
    const ok = await get(`/api/git/diff?location=repo:work&file=${q("a.txt")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.diff).toContain("+TWO");
    for (const file of ["b.txt", "../origin.git/HEAD", "/etc/passwd", "fresh"]) {
      const r = await get(`/api/git/diff?location=repo:work&file=${q(file)}`);
      expect(r.status).toBe(400);
    }
    for (const location of ["repo:nope", "wt:work:nope", "env:x", "/tmp", "repo:../work"]) {
      const r = await get(`/api/git/status?location=${q(location)}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("launch_rejected");
    }
    expect((await get("/api/git/status")).status).toBe(400);
  });

  test("the summary counts every checkout that is a repo", async () => {
    const { body } = await get("/api/git/summary");
    expect(body.items).toEqual({
      "repo:work": { branch: "main", ahead: 1, behind: 1, changed: 4, truncated: false },
    });
  });
});
