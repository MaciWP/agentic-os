import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import {
  applyHunk,
  commitStaged,
  discardPaths,
  discardSnapshot,
  markResolved,
  pushBranch,
  splitHunks,
  stagePaths,
  unstagePaths,
} from "./stage.ts";
import { readDiff, readStatus, type Where } from "./status.ts";
import { GitRefusal } from "./sync.ts";

const GIT = "/usr/bin/git";

let dir: string;
let gitEnv: Record<string, string>;
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([GIT, ...args], { cwd, env: gitEnv, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const put = (cwd: string, file: string, text: string) => writeFileSync(join(cwd, file), text);

// A checkout with one commit, cloned from a bare origin it follows.
function fixture() {
  const root = join(dir, `case-${++n}`);
  mkdirSync(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const work = join(root, "work");
  git(root, "clone", "-q", origin, work);
  put(work, "a.txt", "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "first");
  git(work, "push", "-q", "-u", "origin", "main");
  const at: Where = { bin: GIT, cwd: work, env: gitEnv };
  return { root, origin, work, at };
}

const staged = async (at: Where) =>
  (await readStatus(at)).files.filter((f) => f.x !== "." && f.x !== "?").map((f) => f.path);

const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GitRefusal);
  return (err as GitRefusal).reason;
};

// 30 numbered lines; the ones in `edit` say so, far enough apart to be three hunks.
const lines = (edit: number[] = []) =>
  Array.from({ length: 30 }, (_, i) => (edit.includes(i) ? `line ${i} edited` : `line ${i}`))
    .join("\n")
    .concat("\n");

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-stage-")));
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

describe("stage and unstage", () => {
  test("names with brackets, a leading colon and spaces are staged as themselves", async () => {
    const { work, at } = fixture();
    put(work, "a[1].ts", "x\n");
    put(work, "a1.ts", "y\n");
    put(work, ":odd", "z\n");
    put(work, "with space.txt", "w\n");
    await stagePaths(at, ["a[1].ts", ":odd", "with space.txt"]);
    expect((await staged(at)).sort()).toEqual([":odd", "a[1].ts", "with space.txt"]);
    await unstagePaths(at, ["a[1].ts"]);
    expect((await staged(at)).sort()).toEqual([":odd", "with space.txt"]);
  });

  test("only paths git lists are acted on; a made-up one is refused", async () => {
    const { work, at } = fixture();
    put(work, "a.txt", "changed\n");
    expect(await refusal(stagePaths(at, ["../outside", "nope.txt"]))).toBe("not_found");
    await stagePaths(at, ["a.txt", "nope.txt"]);
    expect(await staged(at)).toEqual(["a.txt"]);
  });

  test("a deletion is staged too, and a rename goes back whole", async () => {
    const { work, at } = fixture();
    git(work, "mv", "a.txt", "b.txt");
    expect(await staged(at)).toEqual(["b.txt"]);
    await unstagePaths(at, ["b.txt"]);
    expect(await staged(at)).toEqual([]);
    await stagePaths(at, ["a.txt"]);
    expect((await readStatus(at)).files.find((f) => f.path === "a.txt")?.x).toBe("D");
  });

  test("before the first commit, unstaging leaves the file untracked", async () => {
    const root = join(dir, `case-${++n}`);
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    const at = { bin: GIT, cwd: root, env: gitEnv };
    put(root, "first.txt", "1\n");
    await stagePaths(at, ["first.txt"]);
    await unstagePaths(at, ["first.txt"]);
    expect((await readStatus(at)).files).toMatchObject([{ path: "first.txt", kind: "untracked" }]);
  });

  test("a nested repo is left to a shell", async () => {
    const { work, at } = fixture();
    git(work, "init", "-q", "inner");
    put(join(work, "inner"), "x", "1\n");
    expect(await refusal(stagePaths(at, ["inner/"]))).toBe("nested");
  });

  test("a held index lock is a refusal to try again", async () => {
    const { work, at } = fixture();
    put(work, "a.txt", "changed\n");
    writeFileSync(join(work, ".git", "index.lock"), "");
    expect(await refusal(stagePaths(at, ["a.txt"]))).toBe("locked");
  });
});

describe("conflicts and discard", () => {
  // Two branches change a.txt; merging them leaves it in conflict.
  function conflict() {
    const f = fixture();
    git(f.work, "checkout", "-q", "-b", "other");
    put(f.work, "a.txt", "theirs\n");
    git(f.work, "commit", "-q", "-am", "theirs");
    git(f.work, "checkout", "-q", "main");
    put(f.work, "a.txt", "mine\n");
    git(f.work, "commit", "-q", "-am", "mine");
    Bun.spawnSync([GIT, "merge", "-q", "other"], { cwd: f.work, env: gitEnv });
    return f;
  }

  test("a conflict is not staged by the plain action; resolving refuses markers", async () => {
    const { work, at } = conflict();
    expect(await refusal(stagePaths(at, ["a.txt"]))).toBe("conflict");
    expect(await refusal(markResolved(at, "a.txt"))).toBe("markers");
    expect(await refusal(commitStaged(at, "merge"))).toBe("conflict");
    put(work, "a.txt", "both\n");
    await markResolved(at, "a.txt");
    expect((await readStatus(at)).files.find((f) => f.path === "a.txt")?.kind).toBe("changed");
  });

  test("discard puts back tracked files only; staged parts stay", async () => {
    const { work, at } = fixture();
    put(work, "a.txt", "staged\n");
    git(work, "add", "a.txt");
    put(work, "a.txt", "staged then more\n");
    put(work, "new.txt", "keep me\n");
    expect(await refusal(discardPaths(at, ["new.txt"]))).toBe("conflict");
    await discardPaths(
      at,
      ["a.txt"],
      { "a.txt": (await discardSnapshot(at, "a.txt")).version },
      dir,
    );
    expect(await Bun.file(join(work, "a.txt")).text()).toBe("staged\n");
    expect(await Bun.file(join(work, "new.txt")).text()).toBe("keep me\n");
  });
});

describe("hunks", () => {
  test("a diff splits into its header and hunks; new and binary files go whole", () => {
    const parts = splitHunks(
      "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n",
    );
    expect(parts.header).toHaveLength(4);
    expect(parts.hunks.map((h) => h.text)).toEqual(["@@ -1 +1 @@\n-a\n+b", "@@ -9 +9 @@\n-c\n+d"]);
    expect(parts.hunkable).toBe(true);
    expect(
      splitHunks("diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1 @@\n+a\n").hunkable,
    ).toBe(false);
    expect(splitHunks("diff --git a/x b/x\nBinary files a/x and b/x differ\n").hunkable).toBe(
      false,
    );
  });

  test("the middle hunk is staged and taken back alone", async () => {
    const { work, at } = fixture();
    put(work, "n.txt", lines());
    git(work, "add", "n.txt");
    git(work, "commit", "-q", "-m", "n");
    put(work, "n.txt", lines([1, 15, 28]));
    const file = (await readStatus(at)).files.find((f) => f.path === "n.txt");
    if (!file) throw new Error("n.txt is not listed");
    const parts = splitHunks((await readDiff(at, file, false)).diff);
    expect(parts.hunks).toHaveLength(3);
    await applyHunk(at, "n.txt", false, 1, (parts.hunks[1] as { digest: string }).digest);
    const cached = git(work, "diff", "--cached");
    expect(cached).toContain("+line 15 edited");
    expect(cached).not.toContain("line 1 edited");
    expect(cached).not.toContain("line 28 edited");
    const back = splitHunks((await readDiff(at, file, true)).diff);
    await applyHunk(at, "n.txt", true, 0, (back.hunks[0] as { digest: string }).digest);
    expect(git(work, "diff", "--cached")).toBe("");
  });

  test("a Windows (CRLF) file keeps its line ends when one hunk is staged", async () => {
    const { work, at } = fixture();
    git(work, "config", "core.autocrlf", "false");
    const crlf = (edit: number[] = []) => lines(edit).replaceAll("\n", "\r\n");
    put(work, "w.txt", crlf());
    git(work, "add", "w.txt");
    git(work, "commit", "-q", "-m", "w");
    put(work, "w.txt", crlf([1, 28]));
    const file = (await readStatus(at)).files.find((f) => f.path === "w.txt");
    if (!file) throw new Error("w.txt is not listed");
    const parts = splitHunks((await readDiff(at, file, false)).diff);
    expect(parts.hunks).toHaveLength(2);
    await applyHunk(at, "w.txt", false, 0, (parts.hunks[0] as { digest: string }).digest);
    // `git` trims its output: every line end but the last is compared.
    expect(git(work, "show", ":w.txt")).toBe(crlf([1]).trimEnd());
  });

  test("a hunk the client saw before the file moved on is refused", async () => {
    const { work, at } = fixture();
    put(work, "a.txt", "two\n");
    expect(await refusal(applyHunk(at, "a.txt", false, 0, "0".repeat(40)))).toBe("stale");
    put(work, "u.txt", "new\n");
    expect(await refusal(applyHunk(at, "u.txt", false, 0, "0".repeat(40)))).toBe("not_hunkable");
  });
});

describe("commit and push", () => {
  test("commits what is staged with the message as written; nothing staged is refused", async () => {
    const { work, at } = fixture();
    put(work, "a.txt", "two\n");
    put(work, "b.txt", "left out\n");
    expect(await refusal(commitStaged(at, "x"))).toBe("nothing_staged");
    await stagePaths(at, ["a.txt"]);
    const done = await commitStaged(at, 'Change a\n\nBody line with `ticks` and "quotes".\n');
    expect(done.summary).toBe("Change a");
    expect(git(work, "log", "-1", "--format=%B")).toBe(
      'Change a\n\nBody line with `ticks` and "quotes".',
    );
    expect((await readStatus(at)).files.map((f) => f.path)).toEqual(["b.txt"]);
  });

  test("a failing pre-commit hook is refused in git's words; it is never skipped", async () => {
    const { work, at } = fixture();
    const hook = join(work, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint says no' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    put(work, "a.txt", "two\n");
    await stagePaths(at, ["a.txt"]);
    const err = await commitStaged(at, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRefusal);
    expect((err as GitRefusal).reason).toBe("commit_failed");
    expect((err as GitRefusal).message).toContain("lint says no");
  });

  test("first push sets the upstream, the next one is plain, a rejected one is refused", async () => {
    const { root, origin, work, at } = fixture();
    git(work, "checkout", "-q", "-b", "feature/x");
    put(work, "a.txt", "two\n");
    await stagePaths(at, ["a.txt"]);
    await commitStaged(at, "two");
    const first = await pushBranch(at);
    expect(first).toMatchObject({ branch: "feature/x", remote: "origin", upstreamSet: true });
    expect((await readStatus(at)).upstream).toBe("origin/feature/x");
    put(work, "a.txt", "three\n");
    await stagePaths(at, ["a.txt"]);
    await commitStaged(at, "three");
    expect(await pushBranch(at)).toMatchObject({ upstreamSet: false, commits: 1 });
    expect(git(origin, "rev-parse", "feature/x")).toBe(git(work, "rev-parse", "HEAD"));
    // Someone else pushes to the same branch first.
    const other = join(root, "other");
    git(root, "clone", "-q", "-b", "feature/x", origin, other);
    put(other, "c.txt", "c\n");
    git(other, "add", "c.txt");
    git(other, "commit", "-q", "-m", "c");
    git(other, "push", "-q");
    put(work, "a.txt", "four\n");
    await stagePaths(at, ["a.txt"]);
    await commitStaged(at, "four");
    expect(await refusal(pushBranch(at))).toBe("behind");
    git(work, "checkout", "-q", "--detach");
    expect(await refusal(pushBranch(at))).toBe("detached");
  });

  test("a repo without a remote has nowhere to push", async () => {
    const root = join(dir, `case-${++n}`);
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    put(root, "a.txt", "1\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-q", "-m", "1");
    expect(await refusal(pushBranch({ bin: GIT, cwd: root, env: gitEnv }))).toBe("no_remote");
  });
});

describe("stage routes", () => {
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "content-type": "application/json",
  };
  const make = (localPath: string) => {
    const config = ConfigSchema.parse({
      git: { bin: GIT },
      terminals: { shell: "/bin/sh" },
      repos: [{ id: "w", localPath }],
    });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () => Promise.resolve(gitEnv));
    const app = createApp({ config, db, terminals, tokens: new AttachTokens() });
    return async (path: string, body: unknown, h: Record<string, string> = headers) => {
      const res = await app.request(path, {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  };

  test("stage, commit and push through the routes; bad bodies and refusals answer early", async () => {
    const { origin, work } = fixture();
    const post = make(work);
    put(work, "a.txt", "two\n");
    expect((await post("/api/git/stage", { location: "repo:w", paths: ["a.txt"] })).status).toBe(
      200,
    );
    expect((await post("/api/git/stage", { location: "repo:w", paths: [] })).status).toBe(400);
    expect((await post("/api/git/commit", { location: "repo:w", message: "  " })).status).toBe(400);
    expect((await post("/api/git/discard", { location: "repo:w", paths: ["a.txt"] })).status).toBe(
      400,
    );
    const done = await post("/api/git/commit", { location: "repo:w", message: "two" });
    expect(done).toMatchObject({ status: 200, body: { summary: "two" } });
    const again = await post("/api/git/commit", { location: "repo:w", message: "two" });
    expect(again).toMatchObject({ status: 409, body: { reason: "nothing_staged" } });
    expect((await post("/api/git/push", { location: "repo:w" })).status).toBe(200);
    expect(git(origin, "rev-parse", "main")).toBe(git(work, "rev-parse", "HEAD"));
  });

  test("a write from another origin never reaches git", async () => {
    const { work } = fixture();
    put(work, "a.txt", "two\n");
    const post = make(work);
    const res = await post(
      "/api/git/stage",
      { location: "repo:w", paths: ["a.txt"] },
      { ...headers, origin: "http://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(git(work, "diff", "--cached")).toBe("");
  });
});

test("discard refuses edits newer than the displayed version", async () => {
  const { work, at } = fixture();
  put(work, "a.txt", "seen\n");
  const seen = await discardSnapshot(at, "a.txt");
  put(work, "a.txt", "new agent edits\n");
  expect(await refusal(discardPaths(at, ["a.txt"], { "a.txt": seen.version }, dir))).toBe("stale");
  expect(await Bun.file(join(work, "a.txt")).text()).toBe("new agent edits\n");
});
