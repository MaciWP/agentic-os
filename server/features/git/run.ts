import { errorMessage } from "../../error-message.ts";
import { type RunResult, run } from "../../run.ts";

export const GIT_TIMEOUT_MS = 10_000;

export class GitError extends Error {}
// A git call cut at its deadline: the caller can tell a slow checkout from a broken one.
export class GitTimeout extends GitError {}

export type GitRun = {
  env: Record<string, string>;
  timeoutMs?: number;
  // Exit codes that mean success for this call: `diff --no-index` exits 1 on a difference.
  ok?: number[];
  // Past this, the process is killed and the output kept so far comes back truncated.
  maxBytes?: number;
  // Written to git's stdin, then closed: a patch for `apply`, a message for `commit -F -`.
  input?: string;
};

// `code` is null only on a truncated result: git was killed at the byte cap.
export type GitResult = { out: string; code: number | null; truncated: boolean };

// Windows: paths past 260 characters (deep node_modules, long test names), for this call only;
// the user's own git config is left alone.
const LONG_PATHS: Record<string, string> =
  process.platform === "win32"
    ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "true" }
    : {};

// Every git call of the app: a fixed argv from the caller, no shell, stdin only for `input`. A read never
// takes the index lock from the user's own git (GIT_OPTIONAL_LOCKS), and nothing waits on a
// credential prompt (GIT_TERMINAL_PROMPT).
export async function runGit(
  bin: string,
  cwd: string,
  args: string[],
  { env, timeoutMs = GIT_TIMEOUT_MS, ok = [0], maxBytes = Number.POSITIVE_INFINITY, input }: GitRun,
): Promise<GitResult> {
  let res: RunResult;
  try {
    res = await run([bin, ...args], {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...LONG_PATHS },
      input,
      timeoutMs,
      maxBytes,
    });
  } catch (err) {
    throw new GitError(`cannot run git in ${cwd}: ${errorMessage(err)}`);
  }
  if (res.timedOut) throw new GitTimeout(`git ${args[0] ?? ""} timed out after ${timeoutMs} ms`);
  if (res.truncated) return { out: res.stdout, code: res.code, truncated: true };
  if (res.code === null) throw new GitError("git was killed");
  if (!ok.includes(res.code)) {
    throw new GitError(`git exited with ${res.code}: ${res.stderr.trim().slice(-300)}`);
  }
  return { out: res.stdout, code: res.code, truncated: false };
}
