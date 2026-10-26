// The one way the server runs a short command: bounded in time and in output, and never left
// behind. The child gets its own process group, so a timeout kills whatever it started too:
// a grandchild that keeps the pipe open would otherwise hold the read past any timeout.
// Long-lived processes (the PTY host, terminals, caffeinate, watchers, workers, env jobs) do
// not use this; `spawn-sites.test.ts` lists them with the reason.

import { basename } from "node:path";
import { log } from "./log.ts";
import { PsSession } from "./ps-session.ts";
import { failed, traced } from "./telemetry/span.ts";

export type RunOptions = {
  timeoutMs: number;
  // Stdout kept, in bytes; past it the command is killed and `truncated` is set.
  maxBytes?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  // The caller's own deadline; aborting kills the command like a timeout.
  signal?: AbortSignal;
  // Written to stdin, then closed. Without it stdin is empty.
  input?: string;
  // What the span says it ran, when the argv does not tell (`zsh login env`).
  name?: string;
};

export type RunResult = {
  // null when the command was killed (timeout, abort, output cap).
  code: number | null;
  stdout: string;
  // The last STDERR_TAIL bytes, for the server log only: never pass it to a client.
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export const STDERR_TAIL = 2048;
const MAX_BYTES = 1024 * 1024;
// After the group is killed, how long a process that left the group (setsid) may keep the
// pipe before the reads are dropped.
const GRACE_MS = 1000;

// Kills a process and everything it started. POSIX: the process group a `detached` spawn
// leads. Windows has no groups: taskkill walks the parent chain instead.
export function killTree(pid: number): void {
  if (pid <= 1) return;
  if (process.platform === "win32") {
    Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is gone: everything in it already exited.
  }
}

// Windows PowerShell 5, always installed, for what only CIM answers (processes, command lines).
// Calls share one PowerShell kept open while they come (ps-session.ts), because starting one
// costs CPU a game can feel: a failed or slow call is logged at once, and a minute's calls once
// a minute (`powershell: 15 calls ...`).
const session = new PsSession();
export async function powershell(command: string, timeoutMs = 5_000): Promise<RunResult> {
  const started = performance.now();
  // Named by its cmdlet: the rest of the line can hold ids and paths.
  const cmdlet = /[A-Z][a-z]+-[A-Za-z]+/.exec(command)?.[0] ?? "script";
  const out = await traced(`powershell ${cmdlet}`, "cmd", {}, async (span) => {
    const res = await session.run(command, timeoutMs);
    span.setAttribute("cmd.exit_code", res.code ?? -1);
    if (res.code !== 0)
      failed(span, res.timedOut ? `timed out after ${timeoutMs} ms` : `exit ${res.code}`);
    return res;
  });
  const ms = Math.round(performance.now() - started);
  const what = command.slice(0, 60);
  if (out.code !== 0) psLog.warn("failed", { ms, code: out.code, what, stderr: out.stderr.trim() });
  else if (ms >= SLOW_PS_MS) psLog.warn("slow", { ms, what });
  calls.push(ms);
  if (!flush)
    flush = setTimeout(() => {
      const done = calls.splice(0);
      flush = undefined;
      psLog.info(`${done.length} calls in the last minute`, {
        avgMs: Math.round(done.reduce((a, b) => a + b, 0) / done.length),
        maxMs: Math.max(...done),
      });
    }, 60_000).unref();
  return out;
}
const psLog = log("powershell");
const SLOW_PS_MS = 1_500;
const calls: number[] = [];
let flush: ReturnType<typeof setTimeout> | undefined;

// A live process's command line, with `/` separators, or "" when it is gone.
export async function commandLine(pid: number): Promise<string> {
  const out =
    process.platform === "win32"
      ? await powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`)
      : await run(["/bin/ps", "-o", "command=", "-p", String(pid)], { env: {}, timeoutMs: 5_000 });
  return out.stdout.trim().replaceAll("\\", "/");
}

// Each command is a span under the current request: named by the program and its first word
// (`git status`, `gh pr`), never the full argv, which can hold a path or a message.
export function run(argv: string[], opts: RunOptions): Promise<RunResult> {
  // `nice -n 10 bun worker.ts` is named after what it runs.
  const start =
    basename(argv[0] ?? "") === "nice"
      ? Math.max(
          0,
          argv.findIndex((a, i) => i > 0 && !/^-|^\d+$/.test(a)),
        )
      : 0;
  const program = basename(argv[start] ?? "").replace(/\.exe$/i, "");
  const verb = opts.name ?? verbOf(program, argv.slice(start + 1));
  const op = program === "git" || program === "gh" ? program : "cmd";
  const attrs = opts.cwd ? { "cmd.cwd": basename(opts.cwd) } : {};
  return traced([program, verb].filter(Boolean).join(" "), op, attrs, async (span) => {
    const out = await runCommand(argv, opts);
    span.setAttribute("cmd.exit_code", out.code ?? -1);
    if (out.truncated) span.setAttribute("cmd.truncated", true);
    if (out.timedOut) failed(span, `timed out after ${opts.timeoutMs} ms`);
    return out;
  });
}

const SHELLS = new Set(["sh", "bash", "zsh"]);
const WORD = /^[a-z][\w.-]{0,30}$/i;

// A word only: a flag's free text (`-m <message>`, `-e <script>`) never names a span. A shell
// is named by the program its command starts with, a runtime by its script's file name.
export function verbOf(program: string, args: string[]): string | undefined {
  if (SHELLS.has(program)) {
    const command = args[args.findIndex((a) => /^-\w*c\w*$/.test(a)) + 1];
    const first = basename(command?.trim().split(/\s+/)[0] ?? "");
    return command !== undefined && WORD.test(first) ? first : undefined;
  }
  const script = args.find((a) => /\.(ts|js|mjs|py|sh)$/.test(a));
  if (script && WORD.test(basename(script))) return basename(script);
  return args.find((a) => /^[a-z][\w-]{0,30}$/i.test(a));
}

async function runCommand(argv: string[], opts: RunOptions): Promise<RunResult> {
  const max = opts.maxBytes ?? MAX_BYTES;
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
    // POSIX: its own process group, for killTree. Windows needs none (taskkill /T), and a
    // detached powershell.exe has no console and prints nothing, exiting 0.
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  let truncated = false;
  let killed = false;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let grace: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    if (killed) return;
    killed = true;
    killTree(proc.pid);
    grace = setTimeout(() => {
      for (const r of readers) void r.cancel().catch(() => {});
    }, GRACE_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  const abort = () => kill();
  if (opts.signal?.aborted) kill();
  opts.signal?.addEventListener("abort", abort, { once: true });

  const drain = async (
    stream: ReadableStream<Uint8Array>,
    take: (chunk: Uint8Array) => boolean,
  ) => {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !take(value)) return;
      }
    } catch {
      // A cancelled or broken pipe ends the read; what was read is kept.
    }
  };

  const out: Uint8Array[] = [];
  let outBytes = 0;
  let err = new Uint8Array(0);
  try {
    await Promise.all([
      drain(proc.stdout, (chunk) => {
        const room = max - outBytes;
        out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        outBytes += Math.min(chunk.length, room);
        if (chunk.length <= room) return true;
        truncated = true;
        kill();
        return false;
      }),
      drain(proc.stderr, (chunk) => {
        const joined = new Uint8Array(err.length + chunk.length);
        joined.set(err);
        joined.set(chunk, err.length);
        err = joined.subarray(Math.max(0, joined.length - STDERR_TAIL));
        return true;
      }),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    opts.signal?.removeEventListener("abort", abort);
  }
  const decoder = new TextDecoder();
  return {
    code: killed ? null : proc.exitCode,
    stdout: decoder.decode(Buffer.concat(out)),
    stderr: decoder.decode(err),
    timedOut,
    truncated,
  };
}
