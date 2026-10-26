import { cached } from "../../cache.ts";
import { footprintKb } from "../../footprint.ts";
import { powershell, run } from "../../run.ts";
import type { SessionSources } from "../sessions/scan.ts";
import { type ExternalSession, type SessionHarness, scanSessions } from "../sessions/scan.ts";
import type { Terminals } from "../terminals/contract.ts";

// What the agent monitor adds to the terminals list: what each process tree costs, the last
// line a shell printed, and Claude's own status word. State and activity come from the
// terminals list itself, which events keep fresh; this is polled while the page is open.

export type ProcRow = { pid: number; ppid: number; cpu: number; rssKb: number };
export type Usage = { cpu: number; rssKb: number };

export type AppAgent = {
  id: string;
  cpu: number | null;
  rssKb: number | null;
  // Shell and env terminals only: an agent's TUI ends its screen with its own chrome.
  lastLine: string | null;
  // Claude's status word (idle, busy, waiting) from its session file.
  status: string | null;
  // Fresher than the list's copy, which a client reads again only when activity flips.
  lastOutputAt: string | null;
};

export type OutsideAgent = ExternalSession & { cpu: number | null; rssKb: number | null };

export type AgentsSnapshot = {
  app: AppAgent[];
  outside: OutsideAgent[];
  missing: SessionHarness[];
};

export const LAST_LINE_CHARS = 200;
const READ_LINES = 5;

// `ps -A -o pid=,ppid=,pcpu=,rss=`: one row per process; anything else is skipped.
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line);
    if (m)
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]) });
  }
  return rows;
}

// Each root with every process below it, except another root and its tree, which count as that
// root: a process is never counted twice. A root ps did not list is gone and has no usage.
export function treeUsage(rows: ProcRow[], roots: Iterable<number>): Map<number, Usage> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const out = new Map<number, Usage>();
  const rootSet = new Set(roots);
  for (const root of rootSet) {
    if (!byPid.has(root)) continue;
    const usage = { cpu: 0, rssKb: 0 };
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length > 0) {
      const pid = stack.pop() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const r = byPid.get(pid);
      if (!r) continue;
      usage.cpu += r.cpu;
      usage.rssKb += r.rssKb;
      stack.push(...(children.get(pid) ?? []).filter((c) => !rootSet.has(c)));
    }
    usage.cpu = Math.round(usage.cpu * 10) / 10;
    out.set(root, usage);
  }
  return out;
}

// Windows: Win32_Process gives the parent, the CPU time spent (100 ns ticks) and the working
// set. The perf-counter class would give the CPU % directly, but it makes WMI refresh every
// counter of every process: a dropped frame in a game on each poll.
const WIN_PROCS =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime," +
  "UserModeTime,WorkingSetSize | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, " +
  "$_.ParentProcessId, ($_.KernelModeTime + $_.UserModeTime), " +
  "[math]::Round($_.WorkingSetSize / 1024) }";

export type Ticks = { at: number; byPid: Map<number, number> };

// WIN_PROCS's rows, with the CPU % of one core (as ps's) from the ticks since `before`: 0 for
// a process the last read did not see, and for every process on the first read.
export function winRows(text: string, at: number, before?: Ticks) {
  const byPid = new Map<number, number>();
  const rows: ProcRow[] = [];
  const wall = before ? (at - before.at) * 10_000 : 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+) (\d+)$/.exec(line.trim());
    // pid 0 is the idle process: its ticks are the idle time.
    if (!m || m[1] === "0") continue;
    const pid = Number(m[1]);
    const ticks = Number(m[3]);
    byPid.set(pid, ticks);
    const was = before?.byPid.get(pid);
    const cpu =
      wall > 0 && was !== undefined && ticks >= was
        ? Math.round(((ticks - was) / wall) * 1000) / 10
        : 0;
    rows.push({ pid, ppid: Number(m[2]), cpu, rssKb: Number(m[4]) });
  }
  return { rows, ticks: { at, byPid } };
}

let lastTicks: Ticks | undefined;
async function winTree(): Promise<ProcRow[]> {
  const { rows, ticks } = winRows((await powershell(WIN_PROCS)).stdout, Date.now(), lastTicks);
  lastTicks = ticks;
  return rows;
}

// Every open page polls this (the header, the agents page): one read serves them all for a few
// seconds, so more tabs never mean more process scans.
const tree = cached(() => (process.platform === "win32" ? winTree() : psRows()), {
  ttlMs: 4_000,
});
export const psTree = (): Promise<ProcRow[]> => tree.get();

async function psRows(): Promise<ProcRow[]> {
  const { stdout: text } = await run(["/bin/ps", "-A", "-o", "pid=,ppid=,pcpu=,rss="], {
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    timeoutMs: 5_000,
  });
  // RSS leaves out compressed and swapped memory (1.1 GB short on the loaded voice model): the
  // footprint, as Activity Monitor shows it, wherever it can be read.
  return parsePs(text).map((r) => ({ ...r, rssKb: footprintKb(r.pid) ?? r.rssKb }));
}

// The last line with something on it, capped.
export function lastLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line)
      return line.length > LAST_LINE_CHARS ? `${line.slice(0, LAST_LINE_CHARS - 1)}…` : line;
  }
  return null;
}

export type MonitorDeps = {
  terminals: Terminals;
  sessions: SessionSources;
  ps?: () => Promise<ProcRow[]>;
  now?: () => number;
};

export async function agentsSnapshot(deps: MonitorDeps): Promise<AgentsSnapshot> {
  const { terminals } = deps;
  const list = await terminals.list();
  const appPids = new Set(list.flatMap((t) => (t.pid === null ? [] : [t.pid])));
  // One scan for both sides: the app's own Claude sessions give their status, the rest are
  // the sessions outside the app.
  const [scan, rows] = await Promise.all([
    scanSessions({ ...deps.sessions, now: deps.now?.() ?? Date.now(), appPids: new Set() }),
    (deps.ps ?? psTree)(),
  ]);
  const outsidePids = scan.sessions.flatMap((s) =>
    s.pid !== null && !appPids.has(s.pid) ? [s.pid] : [],
  );
  const usage = treeUsage(rows, [...appPids, ...outsidePids]);
  const statusByPid = new Map(
    scan.sessions.flatMap((s) => (s.pid !== null && appPids.has(s.pid) ? [[s.pid, s.status]] : [])),
  );
  const app = await Promise.all(
    list.map(async (t): Promise<AppAgent> => {
      const u = t.pid === null ? undefined : usage.get(t.pid);
      const showsLine = t.harness === "shell" || t.harness === "env";
      const screen = showsLine ? await terminals.read(t.id, READ_LINES) : undefined;
      return {
        id: t.id,
        cpu: u?.cpu ?? null,
        rssKb: u?.rssKb ?? null,
        lastLine: screen ? lastLine(screen.text) : null,
        status: (t.pid !== null && statusByPid.get(t.pid)) || null,
        lastOutputAt: t.lastOutputAt,
      };
    }),
  );
  const outside = scan.sessions
    .filter((s) => s.pid === null || !appPids.has(s.pid))
    .map((s): OutsideAgent => {
      const u = s.pid === null ? undefined : usage.get(s.pid);
      return { ...s, cpu: u?.cpu ?? null, rssKb: u?.rssKb ?? null };
    });
  return { app, outside, missing: scan.missing };
}
