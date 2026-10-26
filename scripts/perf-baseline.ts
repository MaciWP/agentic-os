// perf-baseline: the performance figures of the running app, measured the same way each time.
// Read-only: GET requests to the server (default the user's 4317; GET /api/usage reads new
// transcript lines first, as the Consumo page does) and the login shell timed from an empty
// environment, as the PTY host starts it. The shell trace stays in memory and only file:line
// and milliseconds are printed: ~/.zshrc may hold secrets.
//   bun scripts/perf-baseline.ts [--base http://localhost:4317] [--runs 20] [--no-shell]
import { loadavg } from "node:os";
import { dayOf, daysBefore } from "../shared/days.ts";

export type Stats = { n: number; p50: number; p95: number; max: number };

// Nearest-rank percentiles, in the unit given.
export function stats(xs: number[]): Stats {
  if (!xs.length) throw new Error("no samples");
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)] as number;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) as number };
}

const STARTUP = /(^|\/)\.(zshenv|zprofile|zshrc|zlogin)$/;
// Matches the PS4 below: "+<epoch seconds> <file>:<line>> ", one or more "+" for nesting.
const TRACE = /^\++(\d+\.\d+) (\S+):(\d+)> /;
export const PS4 = "+%D{%s.%6.} %x:%I> ";

// Time spent under each line of the user's startup files, from a `zsh -x` trace: a line owns
// everything traced until the next startup-file line, so a sourced script counts on the line
// that sourced it. Only names and numbers come out, never the traced text.
export function attribute(trace: string): { totalMs: number; lines: [string, number][] } {
  const rows: [number, string, number][] = [];
  for (const l of trace.split("\n")) {
    const m = TRACE.exec(l);
    if (m) rows.push([Number(m[1]), m[2] as string, Number(m[3])]);
  }
  if (!rows.length) return { totalMs: 0, lines: [] };
  const acc = new Map<string, number>();
  let cur: string | null = null;
  let since = 0;
  for (const [at, file, line] of rows) {
    if (!STARTUP.test(file)) continue;
    if (cur) acc.set(cur, (acc.get(cur) ?? 0) + (at - since) * 1000);
    cur = `${file.split("/").pop()}:${line}`;
    since = at;
  }
  const end = (rows.at(-1) as [number, string, number])[0];
  if (cur) acc.set(cur, (acc.get(cur) ?? 0) + (end - since) * 1000);
  return {
    totalMs: (end - (rows[0] as [number, string, number])[0]) * 1000,
    lines: [...acc].sort((a, b) => b[1] - a[1]),
  };
}

// The PTY host's login environment: nothing of this process leaks in (server/features/terminals/env.ts).
const cleanEnv = () => ({
  HOME: process.env.HOME ?? "",
  USER: process.env.USER ?? "",
  LOGNAME: process.env.USER ?? "",
  SHELL: "/bin/zsh",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TERM: "xterm-256color",
});

async function shellMs(shell: string): Promise<number> {
  const start = performance.now();
  const proc = Bun.spawn([shell, "-lic", "exit"], {
    env: cleanEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  return performance.now() - start;
}

async function shellTrace(shell: string): Promise<string> {
  const proc = Bun.spawn([shell, "-x", "-lic", "exit"], {
    env: { ...cleanEnv(), PS4 },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const text = await new Response(proc.stderr).text();
  await proc.exited;
  return text;
}

async function getMs(url: string): Promise<number> {
  const start = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return performance.now() - start;
}

// How long the server stops answering while `path` runs: /api/health is asked every 5 ms
// meanwhile and its slowest answer is the stall. Bun serves on one thread, so a synchronous
// handler holds every request and terminal WebSocket for that long.
export async function stallDuring(
  base: string,
  path: string,
): Promise<{ ms: number; stall: number }> {
  let running = true;
  const health: number[] = [];
  const poll = (async () => {
    while (running) {
      health.push(await getMs(`${base}/api/health`));
      await Bun.sleep(5);
    }
  })();
  await Bun.sleep(50);
  const ms = await getMs(`${base}${path}`);
  await Bun.sleep(50);
  running = false;
  await poll;
  return { ms, stall: stats(health).max };
}

const round = (s: Stats) =>
  `p50 ${s.p50.toFixed(0)} · p95 ${s.p95.toFixed(0)} · max ${s.max.toFixed(0)} ms (n=${s.n})`;

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const base = arg("--base") ?? "http://localhost:4317";
  const runs = Number(arg("--runs") ?? 20);
  const now = new Date();
  const usage = `/api/usage?from=${daysBefore(now, 6)}&to=${dayOf(now)}`;
  const load = () =>
    loadavg()
      .map((l) => l.toFixed(2))
      .join(" ");

  console.log(`perf-baseline ${now.toISOString()} · ${base} · load ${load()}`);
  for (const path of [
    "/api/health",
    "/api/terminals",
    "/api/agents",
    "/api/system",
    "/api/usage/activity",
    usage,
  ]) {
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) xs.push(await getMs(`${base}${path}`));
    console.log(`GET ${path.split("?")[0]?.padEnd(20)} ${round(stats(xs))}`);
  }
  const stalls: number[] = [];
  for (let i = 0; i < 5; i++) stalls.push((await stallDuring(base, usage)).stall);
  console.log(`stall during /api/usage ${round(stats(stalls))}`);

  if (!process.argv.includes("--no-shell")) {
    const shell = "/bin/zsh";
    const xs: number[] = [];
    for (let i = 0; i < 5; i++) xs.push(await shellMs(shell));
    console.log(`${shell} -lic exit        ${round(stats(xs))}`);
    const { totalMs, lines } = attribute(await shellTrace(shell));
    console.log(`traced (xtrace slows it) ${totalMs.toFixed(0)} ms; heaviest startup lines:`);
    for (const [where, ms] of lines.slice(0, 6))
      console.log(
        `  ${where.padEnd(16)} ${ms.toFixed(0).padStart(6)} ms  ${((ms / totalMs) * 100).toFixed(0)} %`,
      );
  }
  console.log(`load at end ${load()}`);
}

if (import.meta.main) await main();
