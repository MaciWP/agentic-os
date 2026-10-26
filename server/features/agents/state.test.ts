import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import type { TerminalInfo } from "../terminals/contract.ts";
import {
  claudeSession,
  codexRollouts,
  codexState,
  grokSessions,
  lsofOpenFiles,
  parseLsof,
  START_SLACK_MS,
} from "./discovery.ts";
import { asksDecision, claudeDoing, codexDoing, MESSAGE_CHARS, PROMPT_CHARS } from "./doing.ts";
import { AgentTracker, withAgents } from "./state.ts";

let home: string;
const START = Date.now() - 60_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aos-agents-"));
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const claudeFile = (pid: number, extra: Record<string, unknown> = {}) =>
  writeFileSync(
    join(home, ".claude", "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: "/w", startedAt: START, ...extra }),
  );

const pad = (n: number) => String(n).padStart(2, "0");
function rollout(name: string, meta: Record<string, unknown>, events: string[] = []) {
  const d = new Date();
  const dir = join(
    home,
    ".codex",
    "sessions",
    `${d.getFullYear()}`,
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session_meta", payload: meta }),
    ...events.map((type) => JSON.stringify({ type: "event_msg", payload: { type } })),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const term = (over: Partial<TerminalInfo>): TerminalInfo => ({
  id: "t1",
  harness: "claude",
  location: "app",
  cwd: "/w",
  ticket: null,
  name: null,
  env: null,
  action: null,
  state: "running",
  exitCode: null,
  signal: null,
  error: null,
  overflowed: false,
  attached: false,
  activity: null,
  lastOutputAt: null,
  pid: 101,
  startedAt: new Date(START).toISOString(),
  endedAt: null,
  ...over,
});

describe("harness records", () => {
  test("Claude's status word becomes working or needs_you; waiting says on what", async () => {
    for (const [status, waitingFor, state, asks] of [
      ["busy", undefined, "working", undefined],
      ["waiting", "permission prompt", "needs_you", "permission"],
      ["waiting", "input needed", "needs_you", "question"],
      ["waiting", undefined, "needs_you", "question"],
      ["idle", undefined, "needs_you", undefined],
      ["thinking", undefined, null, undefined],
    ] as const) {
      claudeFile(101, { status, ...(waitingFor ? { waitingFor } : {}) });
      expect(await claudeSession(home, 101, START)).toEqual({
        sessionId: "s-101",
        state,
        ...(asks ? { asks } : {}),
      });
    }
  });

  test("a Claude record of an earlier process with the same pid is not the terminal's", async () => {
    claudeFile(101, { status: "busy", startedAt: START - START_SLACK_MS - 1 });
    expect(await claudeSession(home, 101, START)).toBeNull();
    claudeFile(102, { pid: 999 });
    expect(await claudeSession(home, 102, START)).toBeNull();
    expect(await claudeSession(home, 103, START)).toBeNull();
  });

  test("Grok's open sessions by pid", async () => {
    mkdirSync(join(home, ".grok"));
    writeFileSync(
      join(home, ".grok", "active_sessions.json"),
      JSON.stringify([
        { session_id: "g-1", pid: 301, cwd: "/w", opened_at: new Date(START).toISOString() },
      ]),
    );
    expect(await grokSessions(home)).toEqual(new Map([[301, "g-1"]]));
    rmSync(join(home, ".grok", "active_sessions.json"));
    expect((await grokSessions(home)).size).toBe(0);
  });

  test("a Codex rollout's state is its last turn event", async () => {
    const meta = { id: "c-1", cwd: "/w", timestamp: new Date(START).toISOString() };
    expect(await codexState(rollout("a", meta))).toBe("needs_you");
    expect(await codexState(rollout("b", meta, ["task_started"]))).toBe("working");
    expect(
      await codexState(rollout("c", meta, ["task_started", "token_count", "task_complete"])),
    ).toBe("needs_you");
    expect(await codexState(rollout("d", meta, ["task_started", "turn_aborted"]))).toBe(
      "needs_you",
    );
  });

  test("a running turn stays working after its start leaves the last 256 KB", async () => {
    const path = rollout("long", { id: "long", cwd: "/w" }, ["task_started"]);
    appendFileSync(
      path,
      JSON.stringify({ type: "response_item", payload: "x".repeat(300_000) }) + "\n",
    );
    expect(await codexState(path)).toBe("working");
  });

  test("a rollout cut short or replaced is read as it is now; a half-written line changes nothing", async () => {
    const path = rollout("cut", { id: "cut", cwd: "/w" }, ["task_started", "task_complete"]);
    expect(await codexState(path)).toBe("needs_you");
    // Truncated to its header and a new turn: the turn that ended is gone.
    writeFileSync(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { id: "cut", cwd: "/w" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`,
    );
    expect(await codexState(path)).toBe("working");
    // The end of the turn, still being written, is not an end yet.
    appendFileSync(path, '{"type":"event_msg","payload":{"type":"task_comp');
    expect(await codexState(path)).toBe("working");
    // Another file put in its place is read whole.
    const other = rollout("other", { id: "cut", cwd: "/w" }, ["task_started", "turn_aborted"]);
    renameSync(other, path);
    expect(await codexState(path)).toBe("needs_you");
  });

  test("a rollout that cannot be read has no state, never a finished turn", async () => {
    const path = rollout("locked", { id: "locked", cwd: "/w" }, ["task_started"]);
    expect(await codexState(join(home, "missing.jsonl"))).toBeNull();
    chmodSync(path, 0o000);
    try {
      expect(await codexState(path)).toBeNull();
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("lsof's field output becomes each pid's open files", () => {
    const text = "p101\nfcwd\nn/w\nf12\nn/a b.jsonl\np102\nf3\nn/dev/ttys001\n";
    expect(parseLsof(text)).toEqual(
      new Map([
        [101, ["/w", "/a b.jsonl"]],
        [102, ["/dev/ttys001"]],
      ]),
    );
    expect(parseLsof("").size).toBe(0);
  });

  test("lsof lists a file this process holds open", async () => {
    const path = join(home, "held.jsonl");
    writeFileSync(path, "x");
    const fd = openSync(path, "r");
    try {
      const open = await lsofOpenFiles([process.pid, 999_999_999]);
      expect(open.get(process.pid)).toContain(realpathSync(path));
      expect(open.has(999_999_999)).toBe(false);
    } finally {
      closeSync(fd);
    }
  });

  test("a process's Codex rollouts are its open files under sessions, oldest first", () => {
    const late = rollout(`2026-10-07T09-56-04-${ID_B}`, {});
    const early = rollout(`2026-10-07T09-54-06-${ID_A}`, {});
    const open = [late, join(home, "notes.jsonl"), early, rollout("no-id", {}), "/dev/ttys001"];
    expect(codexRollouts(home, open)).toEqual([
      { path: early, id: ID_A },
      { path: late, id: ID_B },
    ]);
  });
});

const ID_A = "01a1155a-fb5b-7c41-880f-64920d3a6235";
const ID_B = "01a1155c-c8e5-7cf3-bf30-66ac8ead999f";
const ID_C = "01a113ac-bd7a-7c23-947a-769bee3e6cd6";

function tracker(list: TerminalInfo[], open = new Map<number, string[]>()) {
  const db = openDb(":memory:");
  for (const t of list)
    db.query(
      "INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at) VALUES (?, ?, 'app', ?, 'running', ?)",
    ).run(t.id, t.harness, t.cwd, t.startedAt);
  const inner = { list: async () => list, subscribe: () => () => {} };
  const sessions: string[] = [];
  const agents = new AgentTracker(inner, {
    home,
    db,
    openFiles: async () => open,
    onSession: (t, id) => sessions.push(`${t.id}:${id}`),
  });
  let notified = 0;
  agents.subscribe(() => notified++);
  const sessionId = (id: string) =>
    db
      .query<{ session_id: string | null }, [string]>(
        "SELECT session_id FROM terminal_sessions WHERE id = ?",
      )
      .get(id)?.session_id;
  return { agents, notified: () => notified, sessionId, sessions };
}

describe("AgentTracker", () => {
  test("records and reports the session id, and tells listeners only when something changed", async () => {
    claudeFile(101, { status: "busy" });
    const t = term({});
    const { agents, notified, sessionId, sessions } = tracker([t]);
    await agents.kick(true);
    expect(agents.decorate(t).agent).toEqual({ sessionId: "s-101", state: "working" });
    expect(sessionId("t1")).toBe("s-101");
    expect(notified()).toBe(1);
    await agents.kick(false);
    expect(notified()).toBe(1);
    // /clear starts another session in the same process.
    claudeFile(101, { status: "idle", sessionId: "s-new" });
    await agents.kick(false);
    expect(agents.decorate(t).agent).toEqual({ sessionId: "s-new", state: "needs_you" });
    expect(sessionId("t1")).toBe("s-new");
    expect(notified()).toBe(2);
    // Each new session is reported once, for the objectives to file it.
    expect(sessions).toEqual(["t1:s-101", "t1:s-new"]);
  });

  test("an ended agent keeps its session id and has no state; a shell has no agent", async () => {
    claudeFile(101, { status: "busy" });
    const list = [term({}), term({ id: "sh", harness: "shell", pid: 102 })];
    const { agents } = tracker(list);
    await agents.kick(true);
    list[0] = term({ state: "exited", pid: null });
    await agents.kick(true);
    expect(agents.decorate(list[0] as TerminalInfo).agent).toEqual({
      sessionId: "s-101",
      state: null,
    });
    expect(agents.decorate(list[1] as TerminalInfo).agent).toBeNull();
  });

  test("Codex terminals in one folder each take the rollout their process holds", async () => {
    // A rollout nobody holds (another Codex in the folder, the Claude plugin) is nobody's.
    rollout(`2026-10-07T09-50-00-${ID_C}`, {});
    const a = rollout(`2026-10-07T09-54-06-${ID_A}`, {}, ["task_started"]);
    const b = rollout(`2026-10-07T09-56-04-${ID_B}`, {});
    const list = [
      term({ harness: "codex" }),
      term({ id: "t2", harness: "codex", pid: 102 }),
      term({ id: "t3", harness: "codex", pid: 103 }),
    ];
    const open = new Map([
      [101, [a]],
      [102, [b]],
    ]);
    const { agents, sessionId } = tracker(list, open);
    await agents.kick(true);
    expect(agents.decorate(list[0] as TerminalInfo).agent).toEqual({
      sessionId: ID_A,
      state: "working",
    });
    expect(sessionId("t2")).toBe(ID_B);
    // Before its first message a Codex has no rollout yet.
    expect(agents.decorate(list[2] as TerminalInfo).agent).toEqual({
      sessionId: null,
      state: null,
    });
  });

  test("a /resume inside Codex moves the session; the known one stays while open", async () => {
    const a = rollout(`2026-10-07T09-54-06-${ID_A}`, {});
    const b = rollout(`2026-10-07T09-56-04-${ID_B}`, {});
    const t = term({ harness: "codex" });
    const open = new Map([[101, [b]]]);
    const { agents, sessionId } = tracker([t], open);
    await agents.kick(true);
    expect(sessionId("t1")).toBe(ID_B);
    // Several open: the one already known stays, not the oldest.
    open.set(101, [a, b]);
    await agents.kick(false);
    expect(sessionId("t1")).toBe(ID_B);
    open.set(101, [a]);
    await agents.kick(false);
    expect(sessionId("t1")).toBe(ID_A);
    // Nothing open for a moment: the last one seen stays.
    open.set(101, []);
    await agents.kick(false);
    expect(agents.decorate(t).agent?.sessionId).toBe(ID_A);
  });

  test("withAgents adds the agent to what the list and get return", async () => {
    claudeFile(101, { status: "waiting" });
    const list = [term({})];
    const inner = { list: async () => list, subscribe: () => () => {}, get: async () => list[0] };
    const agents = new AgentTracker(inner, { home, db: openDb(":memory:") });
    await agents.kick(true);
    const terminals = withAgents(inner as never, agents);
    expect((await terminals.list())[0]?.agent?.state).toBe("needs_you");
    expect((await terminals.get("t1"))?.agent?.sessionId).toBe("s-101");
  });
});

const transcript = (sessionId: string, records: Record<string, unknown>[]) => {
  const dir = join(home, ".claude", "projects", "-w");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
};

describe("what an agent works on", () => {
  test("Claude: the last session title and prompt, past large records after them", async () => {
    const path = transcript("s-1", [
      { type: "ai-title", aiTitle: "old title" },
      { type: "last-prompt", lastPrompt: "old prompt" },
      { type: "ai-title", aiTitle: "fix the  login\nflow" },
      { type: "last-prompt", lastPrompt: "x".repeat(PROMPT_CHARS + 50) },
      ...Array.from({ length: 3 }, () => ({ type: "attachment", body: "y".repeat(200_000) })),
    ]);
    const doing = await claudeDoing(path);
    expect(doing.title).toBe("fix the login flow");
    expect(doing.prompt).toHaveLength(PROMPT_CHARS);
    expect(doing.prompt?.endsWith("…")).toBe(true);
  });

  test("Claude: a transcript without the records, or none at all, says nothing", async () => {
    expect(await claudeDoing(transcript("s-2", [{ type: "user" }]))).toEqual({});
    expect(await claudeDoing(join(home, "missing.jsonl"))).toEqual({});
  });

  test("Codex: the last message the user typed", async () => {
    const path = rollout("doing", { id: "c1", cwd: "/w", timestamp: new Date().toISOString() });
    const user = (text: string) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", content: [{ type: "text", text }] },
        },
      });
    appendFileSync(path, `${user("first")}\n${user("second ask")}\n`);
    appendFileSync(
      path,
      `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`,
    );
    expect(await codexDoing(path)).toEqual({ prompt: "second ask" });
  });

  test("the tracker adds them to a Claude terminal, and an ended one keeps them", async () => {
    claudeFile(101, { status: "busy" });
    transcript("s-101", [
      { type: "ai-title", aiTitle: "Rail redesign" },
      { type: "last-prompt", lastPrompt: "make the rail compact" },
    ]);
    const list = [term({})];
    const { agents, notified } = tracker(list);
    await agents.kick(true);
    expect(agents.decorate(list[0] as TerminalInfo).agent).toEqual({
      sessionId: "s-101",
      state: "working",
      title: "Rail redesign",
      prompt: "make the rail compact",
    });
    transcript("s-101", [
      { type: "ai-title", aiTitle: "Rail redesign" },
      { type: "last-prompt", lastPrompt: "now the logos" },
    ]);
    await agents.kick(false);
    expect(agents.decorate(list[0] as TerminalInfo).agent?.prompt).toBe("now the logos");
    expect(notified()).toBe(2);
    list[0] = term({ state: "exited", pid: null });
    await agents.kick(true);
    expect(agents.decorate(list[0] as TerminalInfo).agent).toEqual({
      sessionId: "s-101",
      state: null,
      title: "Rail redesign",
      prompt: "now the logos",
    });
  });
});

describe("a turn that waits on the user's decision", () => {
  const said = (text: string) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const ASK = "**Hecho.**\n\n**Espera tu decisión:** borrar o no `/v1/export`.\n\nROBIN: listo.";

  test("the line, bold or plain, anywhere in the text; never a mention mid-sentence", () => {
    expect(asksDecision(ASK)).toBe(true);
    expect(asksDecision("Espera tu decisión: P1")).toBe(true);
    expect(asksDecision("ROBIN: hecho; nada espera tu decisión.")).toBe(false);
    expect(asksDecision("ROBIN: hecho.")).toBe(false);
  });

  test("Claude: only the last text counts, past thinking and tool lines", async () => {
    const records = (last: string) => [
      { type: "ai-title", aiTitle: "t" },
      { type: "last-prompt", lastPrompt: "p" },
      said(ASK),
      said(last),
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } },
      { type: "system" },
    ];
    expect((await claudeDoing(transcript("d-1", records(ASK)))).decides).toBe(true);
    expect(
      (await claudeDoing(transcript("d-2", records("ROBIN: hecho.")))).decides,
    ).toBeUndefined();
  });

  test("Codex: the end of the last turn carries the agent's last message", async () => {
    const path = rollout("decides", { id: "c2", cwd: "/w" });
    const end = (msg: string) =>
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: msg },
      });
    appendFileSync(path, `${end("ROBIN: hecho.")}\n${end(ASK)}\n`);
    expect((await codexDoing(path)).decides).toBe(true);
    appendFileSync(path, `${end("ROBIN: hecho.")}\n`);
    expect((await codexDoing(path)).decides).toBeUndefined();
  });

  test("the tracker turns it into a question only while the agent waits", async () => {
    transcript("s-101", [{ type: "ai-title", aiTitle: "t" }, said(ASK)]);
    const list = [term({})];
    const { agents } = tracker(list);
    claudeFile(101, { status: "idle" });
    await agents.kick(true);
    const agent = () => agents.decorate(list[0] as TerminalInfo).agent;
    expect(agent()).toMatchObject({ state: "needs_you", asks: "question" });
    expect(agent()).not.toHaveProperty("decides");
    claudeFile(101, { status: "busy" });
    await agents.kick(true);
    expect(agent()?.state).toBe("working");
    expect(agent()).not.toHaveProperty("asks");
  });
});

describe("what the agent last said and asks", () => {
  const text = (t: string) => ({
    type: "assistant",
    message: { content: [{ type: "text", text: t }] },
  });
  const ask = (...questions: string[]) => ({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: {
            questions: questions.map((question) => ({ question, header: "h", options: [] })),
          },
        },
      ],
    },
  });
  const answer = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "x" }] },
  };

  test("Claude: the last text as one plain line, capped", async () => {
    const path = transcript("m-1", [
      text("older"),
      text("**Hecho.**\n\nEl `fichero` queda   listo."),
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } },
    ]);
    expect((await claudeDoing(path)).lastMessage).toBe("Hecho. El fichero queda listo.");
    const long = await claudeDoing(transcript("m-2", [text("y".repeat(MESSAGE_CHARS + 20))]));
    expect(long.lastMessage).toHaveLength(MESSAGE_CHARS);
  });

  test("Claude: an AskUserQuestion with no answer after it is the open question", async () => {
    const open = await claudeDoing(
      transcript("q-1", [text("Mira esto."), ask("¿Sigo?", "¿Y L2?")]),
    );
    expect(open).toMatchObject({ question: "¿Sigo? (+1)", lastMessage: "Mira esto." });
    const done = await claudeDoing(transcript("q-2", [ask("¿Sigo?"), answer, text("Sigo.")]));
    expect(done.question).toBeUndefined();
    const pending = await claudeDoing(transcript("q-3", [ask("¿Antes?"), answer, ask("¿Ahora?")]));
    expect(pending.question).toBe("¿Ahora?");
  });

  test("Codex: the agent's message at the end of its last turn", async () => {
    const path = rollout("said", { id: "c3", cwd: "/w" });
    appendFileSync(
      path,
      `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "**Listo.** Tests en verde." } })}\n`,
    );
    expect((await codexDoing(path)).lastMessage).toBe("Listo. Tests en verde.");
  });

  test("the tracker shows the question only while Claude waits on one; an ended agent keeps its last words", async () => {
    transcript("s-101", [text("Te pregunto."), ask("¿Borro la rama?")]);
    const list = [term({})];
    const { agents } = tracker(list);
    const agent = () => agents.decorate(list[0] as TerminalInfo).agent;
    claudeFile(101, { status: "waiting", waitingFor: "input needed" });
    await agents.kick(true);
    expect(agent()).toMatchObject({ asks: "question", question: "¿Borro la rama?" });
    claudeFile(101, { status: "waiting", waitingFor: "permission prompt" });
    await agents.kick(true);
    expect(agent()).toMatchObject({ asks: "permission", lastMessage: "Te pregunto." });
    expect(agent()).not.toHaveProperty("question");
    list[0] = term({ state: "exited", pid: null });
    await agents.kick(true);
    expect(agent()).toMatchObject({ state: null, lastMessage: "Te pregunto." });
  });
});
