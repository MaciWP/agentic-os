import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../../deps.ts";
import { agentRoutes } from "../monitor/routes.ts";
import type { TerminalInfo } from "../terminals/contract.ts";
import { terminalConversation } from "./conversation.ts";

const home = mkdtempSync(join(tmpdir(), "aos-conversation-"));
afterAll(() => rmSync(home, { recursive: true }));

const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const CODEX_ID = "019a0000-1111-7222-8333-444444444444";
const jsonl = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

mkdirSync(join(home, ".claude", "projects", "-repo"), { recursive: true });
writeFileSync(
  join(home, ".claude", "projects", "-repo", `${CLAUDE_ID}.jsonl`),
  jsonl([
    { type: "user", isMeta: true, message: { content: "Caveat: local command" } },
    {
      type: "user",
      isCompactSummary: true,
      message: { content: "This session is being continued" },
    },
    { type: "user", timestamp: "t1", message: { content: "¿Puedes revisar el login?" } },
    { type: "ai-title", aiTitle: "Login" },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
    {
      type: "assistant",
      timestamp: "t2",
      message: { content: [{ type: "text", text: "Miro el código." }] },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "file text" }] } },
    {
      type: "assistant",
      isSidechain: true,
      message: { content: [{ type: "text", text: "subagent" }] },
    },
    { type: "assistant", message: { content: [{ type: "text", text: "Falla en la línea 23." }] } },
    {
      type: "attachment",
      timestamp: "t3",
      attachment: { type: "queued_command", prompt: "Arréglalo" },
    },
    { type: "attachment", attachment: { type: "hook_success", content: "ok" } },
    "not json",
  ]).replace('"not json"', "{broken"),
);

mkdirSync(join(home, ".codex", "sessions", "2026", "10", "08"), { recursive: true });
// As Codex writes them: the user's blocks are "text", the agent's "Text".
const item = (type: string, text: string) => ({
  type: "event_msg",
  timestamp: `ts-${text}`,
  payload: {
    type: "item_completed",
    item: { type, content: [{ type: type === "AgentMessage" ? "Text" : "text", text }] },
  },
});
writeFileSync(
  join(
    home,
    ".codex",
    "sessions",
    "2026",
    "10",
    "08",
    `rollout-2026-10-08T09-00-00-${CODEX_ID}.jsonl`,
  ),
  jsonl([
    item("UserMessage", "Corre los tests"),
    item("Reasoning", "thinking"),
    { type: "response_item", payload: { type: "function_call", name: "shell" } },
    item("AgentMessage", "Pasan 12."),
  ]),
);

const terminal = (harness: TerminalInfo["harness"], sessionId: string | null) =>
  ({ id: `t-${harness}`, harness, agent: { sessionId, state: null } }) as TerminalInfo;

test("Claude: the user's words and the answers, without tool calls, thinking or subagents", async () => {
  expect(await terminalConversation(home, terminal("claude", CLAUDE_ID))).toEqual([
    { role: "user", text: "¿Puedes revisar el login?", at: "t1" },
    // One answer split by a tool call reads as one message.
    { role: "assistant", text: "Miro el código.\n\nFalla en la línea 23.", at: "t2" },
    // Sent while Claude worked.
    { role: "user", text: "Arréglalo", at: "t3" },
  ]);
});

test("the last messages only, oldest first", async () => {
  const last = await terminalConversation(home, terminal("claude", CLAUDE_ID), 2);
  expect(last?.map((m) => m.text)).toEqual(["Falla en la línea 23.", "Arréglalo"]);
});

test("Codex: the user's messages and the agent's, from the rollout of its session", async () => {
  expect(await terminalConversation(home, terminal("codex", CODEX_ID))).toEqual([
    { role: "user", text: "Corre los tests", at: "ts-Corre los tests" },
    { role: "assistant", text: "Pasan 12.", at: "ts-Pasan 12." },
  ]);
});

test("no conversation for a shell, an unknown session or an id that is not a session id", async () => {
  expect(await terminalConversation(home, terminal("shell", null))).toBeNull();
  expect(await terminalConversation(home, terminal("grok", CLAUDE_ID))).toBeNull();
  expect(
    await terminalConversation(home, terminal("claude", "99999999-2222-4333-8444-555555555555")),
  ).toBeNull();
  expect(await terminalConversation(home, terminal("claude", "../../etc/passwd"))).toBeNull();
});

test("the route answers the messages, 409 without a conversation, 404 for another id", async () => {
  const list = [terminal("claude", CLAUDE_ID), terminal("shell", null)];
  const app = agentRoutes({ terminals: { list: () => list } } as unknown as Deps, {
    home,
    procs: async () => new Map(),
  });
  const ok = await app.request(`/t-claude/conversation?limit=1`);
  expect(await ok.json()).toEqual({ messages: [{ role: "user", text: "Arréglalo", at: "t3" }] });
  expect((await app.request("/t-claude/conversation?limit=abc")).status).toBe(200);
  expect((await app.request("/t-shell/conversation")).status).toBe(409);
  expect((await app.request("/nope/conversation")).status).toBe(404);
});
