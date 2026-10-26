import { log } from "../../log.ts";
import { run } from "../../run.ts";

// The PTY environment is the user's own login environment, never the server's.
// The server may run inside another agent session (Claude Code, Orca) whose variables
// would make a launched harness believe it is a child session or leak its tokens.

const STRIP = [
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_/,
  /^CLAUDE_PID$/,
  /^ORCA_/,
  /^AGENTIC_OS_/,
  /^AOS_/,
  /^NODE_ENV$/,
];
// Variables the login shell cannot recreate but a terminal needs (ssh-agent for git).
const PASSTHROUGH = ["SSH_AUTH_SOCK"];
const MARK = "\0__AOS_ENV__\0";

export function cleanEnv(
  login: Record<string, string>,
  parent: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(login)) {
    if (!STRIP.some((re) => re.test(key))) env[key] = value;
  }
  for (const key of PASSTHROUGH) {
    const value = parent[key];
    if (value && !env[key]) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (!/UTF-8/i.test(env.LANG ?? "")) env.LANG = "en_US.UTF-8";
  return env;
}

// PATH with `dirs` first. Windows spells the key `Path` and treats names case-insensitively,
// so the existing entry is replaced, never duplicated beside a second spelling.
export function prependPath(
  env: Record<string, string>,
  dirs: string[],
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out = { ...env };
  const key =
    platform === "win32" ? Object.keys(out).find((k) => k.toUpperCase() === "PATH") : "PATH";
  const current = (key && out[key]) || (platform === "win32" ? "" : "/usr/bin:/bin");
  if (key) delete out[key];
  out.PATH = [...dirs, current].filter(Boolean).join(platform === "win32" ? ";" : ":");
  return out;
}

export function parseEnvDump(out: string): Record<string, string> {
  const at = out.lastIndexOf(MARK);
  if (at < 0) throw new Error("login shell printed no environment");
  const env: Record<string, string> = {};
  for (const pair of out.slice(at + MARK.length).split("\0")) {
    const eq = pair.indexOf("=");
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

// The login environment, read once and kept. A failed read is forgotten, so the next launch
// tries again instead of failing until a restart; callers during a read share it.
export function loginEnvLoader(
  load: () => Promise<Record<string, string>>,
): () => Promise<Record<string, string>> {
  let current: Promise<Record<string, string>> | null = null;
  return () => {
    if (current) return current;
    const attempt = load();
    current = attempt;
    attempt.catch((err) => {
      if (current === attempt) current = null;
      log("terminals").error("login environment unavailable", { err });
    });
    return attempt;
  };
}

// A login shell that loads pyenv, nvm and the like can take 15-20 s on a busy machine. Past this
// the read fails and no terminal can launch until the next try.
const LOGIN_ENV_TIMEOUT_MS = 45_000;

// Runs the login shell from an empty environment, so nothing of the server's leaks in.
export async function loadLoginEnv(
  shell: string,
  timeoutMs = LOGIN_ENV_TIMEOUT_MS,
): Promise<Record<string, string>> {
  // Windows: the worker is started by hand from the user's own session, so its environment
  // is the login environment; there is no login shell to ask.
  if (process.platform === "win32")
    return cleanEnv(process.env as Record<string, string>, process.env);
  const home = process.env.HOME ?? "";
  const user = process.env.USER ?? "";
  const res = await run([shell, "-lic", `printf '\\0__AOS_ENV__\\0'; env -0`], {
    name: "login env",
    timeoutMs,
    env: {
      HOME: home,
      USER: user,
      LOGNAME: user,
      SHELL: shell,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });
  if (res.timedOut) throw new Error(`login shell timed out after ${timeoutMs} ms`);
  return cleanEnv(parseEnvDump(res.stdout), process.env);
}
