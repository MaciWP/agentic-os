import { basename, join, sep } from "node:path";
import { z } from "zod";
import { jsonOrNull } from "../../json.ts";
import { run } from "../../run.ts";
import { ClaudeFile, GrokFile, readSmall } from "../sessions/scan.ts";
import type { AgentInfo, AgentState, TerminalInfo } from "../terminals/contract.ts";

// A record started this long before the terminal belongs to an earlier process with its pid.
export const START_SLACK_MS = 10_000;
const CODEX_TAIL_BYTES = 256 * 1024;

export const AGENTS = new Set<TerminalInfo["harness"]>(["claude", "codex", "grok"]);

// Busy is working; a permission asked or a finished turn both wait for the user.
const CLAUDE_STATE = new Map<string, AgentState>([
  ["busy", "working"],
  ["waiting", "needs_you"],
  ["idle", "needs_you"],
]);

export async function claudeSession(
  home: string,
  pid: number,
  startedMs: number,
): Promise<AgentInfo | null> {
  const raw = await readSmall(join(home, ".claude", "sessions", `${pid}.json`));
  const file = raw && ClaudeFile.safeParse(jsonOrNull(raw.text));
  if (!file?.success || file.data.pid !== pid) return null;
  if (file.data.startedAt !== undefined && file.data.startedAt < startedMs - START_SLACK_MS)
    return null;
  const info: AgentInfo = {
    sessionId: file.data.sessionId,
    state: CLAUDE_STATE.get(file.data.status ?? "") ?? null,
  };
  // "waiting" is Claude stopped mid-turn, on a permission ("permission prompt") or on a
  // question ("input needed"); "idle" is a finished turn.
  if (file.data.status !== "waiting") return info;
  return {
    ...info,
    asks: file.data.waitingFor === "permission prompt" ? "permission" : "question",
  };
}

// Grok's open sessions by pid.
export async function grokSessions(home: string): Promise<Map<number, string>> {
  const raw = await readSmall(join(home, ".grok", "active_sessions.json"));
  const file = raw && GrokFile.safeParse(jsonOrNull(raw.text));
  return new Map(file?.success ? file.data.map((s) => [s.pid, s.session_id]) : []);
}

export type Rollout = { path: string; id: string };

// The files each pid holds open, from `lsof -Fn`: a `p` line per process, then an `n` line
// per file name. Other lines are skipped.
export function parseLsof(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let files: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      files = [];
      out.set(Number(line.slice(1)), files);
    } else if (line.startsWith("n")) files?.push(line.slice(1));
  }
  return out;
}

export type OpenFiles = (pids: number[]) => Promise<Map<number, string[]>>;

// One lsof call for every pid asked about. A pid that has gone is simply missing.
export const lsofOpenFiles: OpenFiles = async (pids) => {
  if (pids.length === 0) return new Map();
  const res = await run(["/usr/sbin/lsof", "-a", "-p", pids.join(","), "-Fn"], {
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin" },
    timeoutMs: 5_000,
  });
  return parseLsof(res.stdout);
};

const ROLLOUT_NAME =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// The Codex rollouts among a process's open files, oldest first: the name starts with the
// time Codex created it, and ends with the session id `codex resume` takes.
export function codexRollouts(home: string, files: string[]): Rollout[] {
  const root = join(home, ".codex", "sessions") + sep;
  const out: Rollout[] = [];
  for (const path of files) {
    if (!path.startsWith(root)) continue;
    const id = ROLLOUT_NAME.exec(basename(path))?.[1];
    if (id) out.push({ path, id });
  }
  return out.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
}

const CodexEvent = z.looseObject({
  type: z.literal("event_msg"),
  payload: z.looseObject({ type: z.string() }),
});

// Visits a JSONL file's lines from the last one back until `visit` returns true, a tail at a
// time: one turn's output can push what is looked for out of the last tail. A tail is cut at
// a newline byte, which never sits inside a UTF-8 character, so each line is decoded whole.
// False when the file cannot be read; it stops after `maxBytes` read.
export async function scanBackwards(
  path: string,
  visit: (line: string) => boolean,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  let end = file.size;
  let carry = new Uint8Array(0);
  while (end > 0 && file.size - end < maxBytes) {
    const start = Math.max(0, end - CODEX_TAIL_BYTES);
    const chunk = await file
      .slice(start, end)
      .bytes()
      .catch(() => null);
    if (chunk === null) return false;
    let bytes = new Uint8Array(chunk.length + carry.length);
    bytes.set(chunk);
    bytes.set(carry, chunk.length);
    // The first line may begin in the tail before this one; a tail with no newline is all one line.
    const newline = bytes.indexOf(0x0a);
    const cut = start === 0 ? 0 : newline === -1 ? bytes.length : newline + 1;
    carry = bytes.slice(0, cut);
    bytes = bytes.subarray(cut);
    const lines = new TextDecoder().decode(bytes).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) if (visit(lines[i] ?? "")) return true;
    end = start;
  }
  return true;
}

// The last turn event of a rollout. Codex records no approval request, so a permission it
// waits on still reads as working.
export async function codexState(path: string): Promise<AgentState | null> {
  // No turn yet: it waits for the first prompt.
  let state: AgentState = "needs_you";
  const read = await scanBackwards(path, (line) => {
    if (!line.includes('"event_msg"')) return false;
    const event = CodexEvent.safeParse(jsonOrNull(line));
    const type = event.success ? event.data.payload.type : "";
    if (type === "task_started") state = "working";
    else if (type !== "task_complete" && type !== "turn_aborted") return false;
    return true;
  });
  return read ? state : null;
}
