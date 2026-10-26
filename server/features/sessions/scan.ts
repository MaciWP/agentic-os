import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { powershell, run } from "../../run.ts";
import type { Harness } from "../terminals/harness.ts";

// Harness sessions running outside the app, read from the files each harness keeps.
// View only: nothing here writes, signals or attaches. "activa" needs proof of the
// process; without it the state is only as good as the file's mtime.

export type SessionHarness = Exclude<Harness, "shell">;
export type SessionState = "activa" | "reciente" | "desconocida";

export type ExternalSession = {
  harness: SessionHarness;
  id: string;
  pid: number | null;
  cwd: string;
  name: string | null;
  kind: string | null;
  // The harness's own status word (Claude: idle, busy, waiting); only meaningful when activa.
  status: string | null;
  state: SessionState;
  startedAt: string | null;
  updatedAt: string | null;
};

export type SessionScan = {
  sessions: ExternalSession[];
  // Files that exist but could not be read as a session.
  skipped: number;
  // Session files whose process is proven gone (or replaced by another process).
  ended: number;
  // Harnesses with no session store on this machine.
  missing: SessionHarness[];
};

export type Proc = { start: number; comm: string };
export type ScanDeps = {
  home: string;
  now: number;
  // Pids of the app's own terminals: those sessions are already in the terminals list.
  appPids: Set<number>;
  procs: (pids: number[]) => Promise<Map<number, Proc>>;
};

export const RECENT_MS = 10 * 60_000;
const CODEX_WINDOW_MS = 24 * 3600_000;
// ponytail: a session started more than a week ago and still writing is missed; widen it then.
const CODEX_DAYS = 7;
const MAX_FILE_BYTES = 1 << 20;
const MAX_CODEX_FILES = 200;
const GROK_START_SLACK_MS = 10_000;

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
// `ps -o lstart` and Claude's procStart share this shape, both in UTC: "Thu Oct  1 07:08:43 2026".
export function parseLstart(s: string): number | null {
  const m = /^\w{3} (\w{3})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] ?? "") / 3;
  if (!Number.isInteger(month) || month < 0) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

// One `ps` for every pid; a pid missing from the output is a process that is gone.
// macOS ps rejects the whole call for a pid above its PID_MAX, so one bad file would hide
// every session; such a pid cannot be running anyway.
const PID_MAX = process.platform === "darwin" ? 99_999 : 4_194_304;

export async function psProcs(pids: number[]): Promise<Map<number, Proc>> {
  const out = new Map<number, Proc>();
  const valid = [...new Set(pids)].filter((p) => p <= PID_MAX);
  if (valid.length === 0) return out;
  if (process.platform === "win32") return winProcs(valid);
  const { stdout: text } = await run(
    ["/bin/ps", "-o", "pid=,lstart=,comm=", "-p", valid.join(",")],
    {
      env: { TZ: "UTC", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
    },
  );
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    const start = m && parseLstart(m[2] ?? "");
    if (m && start !== null) out.set(Number(m[1]), { start, comm: m[3] ?? "" });
  }
  return out;
}

// Windows: the same pid -> start and name, from CIM; start cut to whole seconds, as lstart.
async function winProcs(pids: number[]): Promise<Map<number, Proc>> {
  const out = new Map<number, Proc>();
  const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
  const { stdout } = await powershell(
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { '{0} {1} {2}' -f ` +
      "$_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.Name }",
  );
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (.+)$/.exec(line.trim());
    if (m)
      out.set(Number(m[1]), { start: Math.floor(Number(m[2]) / 1000) * 1000, comm: m[3] ?? "" });
  }
  return out;
}

// Date's own range: a value past it would throw RangeError and abort the whole scan.
const MAX_DATE_MS = 8.64e15;
const iso = (ms: number | null | undefined) =>
  typeof ms === "number" && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : null;

const byMtime = (mtime: number, now: number): SessionState =>
  now - mtime <= RECENT_MS ? "reciente" : "desconocida";

export async function readSmall(path: string): Promise<{ text: string; mtime: number } | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > MAX_FILE_BYTES) return null;
    return { text: await Bun.file(path).text(), mtime: s.mtimeMs };
  } catch {
    return null;
  }
}

async function list(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch {
    return null;
  }
}

// Claude's own record of a running session, `~/.claude/sessions/<pid>.json`.
export const ClaudeFile = z.looseObject({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  procStart: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  // What a "waiting" session waits on: "permission prompt", "input needed".
  waitingFor: z.string().optional(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

type Partial = { sessions: ExternalSession[]; skipped: number; ended: number; missing: boolean };

async function scanClaude(deps: ScanDeps): Promise<Partial> {
  const dir = join(deps.home, ".claude", "sessions");
  const names = await list(dir);
  const res: Partial = { sessions: [], skipped: 0, ended: 0, missing: names === null };
  // Only <pid>.json: the same directory holds key files that are never read.
  const files = (names ?? []).filter((n) => /^\d+\.json$/.test(n));
  const parsed: { file: z.infer<typeof ClaudeFile>; mtime: number }[] = [];
  for (const name of files) {
    const raw = await readSmall(join(dir, name));
    let json: unknown = null;
    try {
      json = raw && JSON.parse(raw.text);
    } catch {}
    const file = ClaudeFile.safeParse(json);
    if (!raw || !file.success) res.skipped++;
    else parsed.push({ file: file.data, mtime: raw.mtime });
  }
  const procs = await deps.procs(parsed.map((p) => p.file.pid));
  for (const { file, mtime } of parsed) {
    if (deps.appPids.has(file.pid)) continue;
    const proc = procs.get(file.pid);
    const started = file.procStart ? parseLstart(file.procStart) : null;
    // A live pid only counts if it is the same process: pids get reused.
    if (!proc || (started !== null && proc.start !== started)) {
      res.ended++;
      continue;
    }
    res.sessions.push({
      harness: "claude",
      id: file.sessionId,
      pid: file.pid,
      cwd: file.cwd,
      name: file.name ?? null,
      kind: file.kind ?? null,
      status: file.status ?? null,
      state: started !== null ? "activa" : byMtime(mtime, deps.now),
      startedAt: iso(file.startedAt),
      updatedAt: iso(file.updatedAt ?? mtime),
    });
  }
  return res;
}

// Grok's open sessions, `~/.grok/active_sessions.json`.
export const GrokFile = z.array(
  z.looseObject({
    session_id: z.string().min(1),
    pid: z.number().int().positive(),
    cwd: z.string().min(1),
    opened_at: z.iso.datetime({ offset: true }),
  }),
);

async function scanGrok(deps: ScanDeps): Promise<Partial> {
  const path = join(deps.home, ".grok", "active_sessions.json");
  const raw = await readSmall(path);
  const exists = raw !== null || (await list(join(deps.home, ".grok"))) !== null;
  const res: Partial = { sessions: [], skipped: 0, ended: 0, missing: !exists };
  if (!raw) return res;
  let json: unknown = null;
  try {
    json = JSON.parse(raw.text);
  } catch {}
  const file = GrokFile.safeParse(json);
  if (!file.success) {
    res.skipped++;
    return res;
  }
  const procs = await deps.procs(file.data.map((s) => s.pid));
  for (const s of file.data) {
    if (deps.appPids.has(s.pid)) continue;
    const proc = procs.get(s.pid);
    const opened = Date.parse(s.opened_at);
    // The same grok process that opened it: a reused pid started later or is something else.
    if (
      !proc ||
      !basename(proc.comm).startsWith("grok") ||
      proc.start > opened + GROK_START_SLACK_MS
    ) {
      res.ended++;
      continue;
    }
    res.sessions.push({
      harness: "grok",
      id: s.session_id,
      pid: s.pid,
      cwd: s.cwd,
      name: null,
      kind: null,
      status: null,
      state: "activa",
      startedAt: iso(opened),
      updatedAt: null,
    });
  }
  return res;
}

// The first line of a Codex rollout.
export const CodexMeta = z.looseObject({
  type: z.literal("session_meta"),
  payload: z.looseObject({
    id: z.string().min(1),
    cwd: z.string().min(1),
    timestamp: z.string().optional(),
    originator: z.string().optional(),
  }),
});

// ponytail: Codex keeps no pid, so its sessions are never "activa" and app-launched ones are
// not filtered out; match the rollout's open handle (lsof) if that misleads.
async function scanCodex(deps: ScanDeps): Promise<Partial> {
  const root = join(deps.home, ".codex", "sessions");
  const years = await list(root);
  const res: Partial = { sessions: [], skipped: 0, ended: 0, missing: years === null };
  if (!years) return res;
  // Rollouts live under the local YYYY/MM/DD they started on, and a long session keeps
  // writing to it: scan the last CODEX_DAYS calendar days and keep what changed recently.
  // Calendar arithmetic, not ms, so a DST change never skips a day.
  const days: string[] = [];
  const today = new Date(deps.now);
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < CODEX_DAYS; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push(join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  const candidates: { path: string; mtime: number }[] = [];
  for (const day of days) {
    for (const name of (await list(join(root, day))) ?? []) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const path = join(root, day, name);
      try {
        const s = await stat(path);
        if (s.isFile() && deps.now - s.mtimeMs <= CODEX_WINDOW_MS)
          candidates.push({ path, mtime: s.mtimeMs });
      } catch {}
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { path, mtime } of candidates.slice(0, MAX_CODEX_FILES)) {
    // The header is the first line; it carries the instructions, so it can be large.
    const head = await Bun.file(path)
      .slice(0, MAX_FILE_BYTES)
      .text()
      .catch(() => "");
    const nl = head.indexOf("\n");
    let json: unknown = null;
    try {
      json = nl > 0 && JSON.parse(head.slice(0, nl));
    } catch {}
    const meta = CodexMeta.safeParse(json);
    if (!meta.success) {
      res.skipped++;
      continue;
    }
    const p = meta.data.payload;
    const started = p.timestamp ? Date.parse(p.timestamp) : Number.NaN;
    res.sessions.push({
      harness: "codex",
      id: p.id,
      pid: null,
      cwd: p.cwd,
      name: null,
      kind: p.originator ?? null,
      status: null,
      state: byMtime(mtime, deps.now),
      startedAt: iso(Number.isFinite(started) ? started : null),
      updatedAt: iso(mtime),
    });
  }
  return res;
}

const ORDER: Record<SessionState, number> = { activa: 0, reciente: 1, desconocida: 2 };

export async function scanSessions(deps: ScanDeps): Promise<SessionScan> {
  const parts = await Promise.all([scanClaude(deps), scanCodex(deps), scanGrok(deps)]);
  const harnesses: SessionHarness[] = ["claude", "codex", "grok"];
  const sessions = parts
    .flatMap((p) => p.sessions)
    .sort(
      (a, b) =>
        ORDER[a.state] - ORDER[b.state] ||
        (b.updatedAt ?? b.startedAt ?? "").localeCompare(a.updatedAt ?? a.startedAt ?? ""),
    );
  return {
    sessions,
    skipped: parts.reduce((n, p) => n + p.skipped, 0),
    ended: parts.reduce((n, p) => n + p.ended, 0),
    missing: harnesses.filter((_, i) => parts[i]?.missing),
  };
}

export type SessionSources = Pick<ScanDeps, "home" | "procs">;

export const userSessionSources = (): SessionSources => ({ home: homedir(), procs: psProcs });
