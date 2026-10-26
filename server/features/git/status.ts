import { realpath } from "node:fs/promises";
import { samePath } from "../../paths.ts";
import { GitError, runGit } from "./run.ts";

export const MAX_FILES = 2000;
export const MAX_STATUS_BYTES = 4 * 1024 * 1024;
export const MAX_DIFF_BYTES = 512 * 1024;

export type FileKind = "changed" | "renamed" | "conflict" | "untracked";

// X is the index side, Y the worktree side; "." is unchanged, "?" untracked.
export type GitFile = { path: string; orig: string | null; x: string; y: string; kind: FileKind };

export type GitStatus = {
  repo: true;
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFile[];
  truncated: boolean;
};

// Splits off `count` space-separated fields; the rest is the path, which may hold spaces.
function fields(record: string, count: number): [string[], string] | null {
  const parts: string[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(" ", at);
    if (space < 0) return null;
    parts.push(record.slice(at, space));
    at = space + 1;
  }
  return [parts, record.slice(at)];
}

// `git status --porcelain=v2 --branch -z`: every header and record ends with a NUL; a rename
// carries its original path as one more NUL-ended field. Ignored files (`!`) are never asked
// for.
export function parseStatus(out: string, truncated = false): GitStatus {
  const status: GitStatus = {
    repo: true,
    branch: null,
    oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    files: [],
    truncated,
  };
  const records = out.split("\0");
  // The text after the last NUL is never a whole record: empty, or the cut end of a
  // truncated output. A rename cut before its original path is dropped below.
  records.pop();
  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? "";
    if (r.startsWith("# ")) {
      const [key = "", ...rest] = r.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") status.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") status.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    let file: GitFile | null = null;
    if (r.startsWith("1 ")) {
      const f = fields(r, 8);
      if (f)
        file = { path: f[1], orig: null, x: xy(f[0][1], 0), y: xy(f[0][1], 1), kind: "changed" };
    } else if (r.startsWith("2 ")) {
      const f = fields(r, 9);
      const orig = records[++i];
      if (f && orig !== undefined)
        file = { path: f[1], orig, x: xy(f[0][1], 0), y: xy(f[0][1], 1), kind: "renamed" };
    } else if (r.startsWith("u ")) {
      const f = fields(r, 10);
      if (f)
        file = { path: f[1], orig: null, x: xy(f[0][1], 0), y: xy(f[0][1], 1), kind: "conflict" };
    } else if (r.startsWith("? ")) {
      file = { path: r.slice(2), orig: null, x: "?", y: "?", kind: "untracked" };
    }
    if (!file) continue;
    if (status.files.length === MAX_FILES) {
      status.truncated = true;
      break;
    }
    status.files.push(file);
  }
  return status;
}

const xy = (code: string | undefined, side: 0 | 1) => code?.[side] ?? ".";

export type Where = { bin: string; cwd: string; env: Record<string, string> };

// A location is a repo only when git's top level is the location itself: the app's folder
// or an env's root may sit inside some other checkout, which is not theirs to show.
export async function isRepoRoot({ bin, cwd, env }: Where): Promise<boolean> {
  try {
    const { out } = await runGit(bin, cwd, ["rev-parse", "--show-toplevel"], { env });
    const top = await realpath(out.trim()).catch(() => null);
    return top !== null && samePath(top, cwd);
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

// The branch checked out at `cwd`; null for a detached HEAD, a folder outside git or no git.
export async function currentBranch({ bin, cwd, env }: Where): Promise<string | null> {
  if (!bin) return null;
  try {
    return (await runGit(bin, cwd, ["branch", "--show-current"], { env })).out.trim() || null;
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

export async function readStatus({ bin, cwd, env }: Where, timeoutMs?: number) {
  const { out, truncated } = await runGit(
    bin,
    cwd,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    { env, timeoutMs, maxBytes: MAX_STATUS_BYTES },
  );
  return parseStatus(out, truncated);
}

// The empty side of a new file's diff. Git for Windows reads `/dev/null` as a folder and
// `\\.\nul` as a missing file; only `nul` works there.
export const nullFile = (platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? "nul" : "/dev/null";

export type GitDiff = { diff: string; truncated: boolean; note: string | null };

// The diff of one file the status lists, never of a path from the client. External diff
// drivers and textconv filters are off: a diff runs nothing the repo's config names. The
// prefixes are fixed, whatever diff.noprefix says, so a hunk of it applies as it is.
export async function readDiff(where: Where, file: GitFile, staged: boolean): Promise<GitDiff> {
  const { bin, cwd, env } = where;
  const base = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  if (file.kind === "untracked") {
    // A nested repo or an empty dir is listed with a trailing slash; it has no text.
    if (file.path.endsWith("/")) return { diff: "", truncated: false, note: "directorio" };
    const { out, code, truncated } = await runGit(
      bin,
      cwd,
      ["diff", "--no-index", ...base, "--", nullFile(), file.path],
      { env, ok: [0, 1], maxBytes: MAX_DIFF_BYTES },
    );
    // Exit 1 is a difference or an error; a new file, even an empty one, always has a header.
    if (code === 1 && !out) throw new GitError(`git diff --no-index failed for ${file.path}`);
    return { diff: out, truncated, note: null };
  }
  const paths = file.orig ? [file.orig, file.path] : [file.path];
  const { out, truncated } = await runGit(
    bin,
    cwd,
    ["diff", ...(staged ? ["--cached", "-M"] : []), ...base, "--", ...paths],
    { env, maxBytes: MAX_DIFF_BYTES },
  );
  return { diff: out, truncated, note: null };
}
