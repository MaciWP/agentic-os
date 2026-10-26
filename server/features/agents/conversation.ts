import { join } from "node:path";
import { z } from "zod";
import { CONVERSATION, type ConversationMessage } from "../../../shared/terminals.ts";
import { jsonOrNull } from "../../json.ts";
import type { TerminalInfo } from "../terminals/contract.ts";
import { scanBackwards } from "./discovery.ts";
import { claudeTranscript } from "./doing.ts";

// An agent's conversation read from its transcript (Claude) or rollout (Codex), for a phone
// that reads it as text instead of the terminal. Read from the end: a long session's
// transcript is mostly tool output, so the scan stops at `limit` messages or after
// CONVERSATION_BYTES.

const CONVERSATION_BYTES = 16 << 20;
// Session ids become file names; anything else is refused before a path is built.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Text = z.looseObject({ type: z.string(), text: z.string().optional() });
const Content = z.union([z.string(), z.array(Text)]);
const textOf = (content: z.infer<typeof Content>) =>
  typeof content === "string"
    ? content
    : content
        // Codex writes the agent's blocks as "Text", the user's as "text".
        .filter((c) => c.type.toLowerCase() === "text")
        .map((c) => c.text ?? "")
        .join("\n\n");

const ClaudeMessage = z.looseObject({
  type: z.enum(["user", "assistant"]),
  // Claude's own notes to itself (caveats, command output), not the user's words.
  isMeta: z.boolean().optional(),
  // A subagent's turn.
  isSidechain: z.boolean().optional(),
  // The summary that replaces the conversation after a compaction.
  isCompactSummary: z.boolean().optional(),
  timestamp: z.string().optional(),
  message: z.looseObject({ content: Content }),
});
// A message the user sent while Claude worked: it is queued, not written as a user record.
const ClaudeQueued = z.looseObject({
  type: z.literal("attachment"),
  timestamp: z.string().optional(),
  attachment: z.looseObject({ type: z.literal("queued_command"), prompt: Content }),
});

export function claudeLine(line: string): ConversationMessage | null {
  if (line.includes('"queued_command"')) {
    const r = ClaudeQueued.safeParse(jsonOrNull(line));
    if (!r.success) return null;
    const text = textOf(r.data.attachment.prompt).trim();
    return text ? { role: "user", text, at: r.data.timestamp ?? null } : null;
  }
  if (!line.includes('"user"') && !line.includes('"assistant"')) return null;
  const r = ClaudeMessage.safeParse(jsonOrNull(line));
  if (!r.success || r.data.isMeta || r.data.isSidechain || r.data.isCompactSummary) return null;
  // A user record that only carries tool results has no text block, so it is skipped here.
  const text = textOf(r.data.message.content).trim();
  return text ? { role: r.data.type, text, at: r.data.timestamp ?? null } : null;
}

const CodexItem = z.looseObject({
  type: z.literal("event_msg"),
  timestamp: z.string().optional(),
  payload: z.looseObject({
    type: z.literal("item_completed"),
    item: z.looseObject({
      type: z.enum(["UserMessage", "AgentMessage"]),
      content: z.array(Text),
    }),
  }),
});

export function codexLine(line: string): ConversationMessage | null {
  if (!line.includes('"UserMessage"') && !line.includes('"AgentMessage"')) return null;
  const r = CodexItem.safeParse(jsonOrNull(line));
  if (!r.success) return null;
  const text = textOf(r.data.payload.item.content).trim();
  const role = r.data.payload.item.type === "UserMessage" ? "user" : "assistant";
  return text ? { role, text, at: r.data.timestamp ?? null } : null;
}

// The last `limit` messages, oldest first, with one speaker's consecutive messages joined:
// an answer split by tool calls reads as one.
export async function readConversation(
  path: string,
  line: (text: string) => ConversationMessage | null,
  limit = CONVERSATION.limit,
): Promise<ConversationMessage[] | null> {
  const found: ConversationMessage[] = [];
  const read = await scanBackwards(
    path,
    (text) => {
      const message = line(text);
      if (message) found.push(message);
      return found.length >= limit;
    },
    CONVERSATION_BYTES,
  );
  if (!read) return null;
  const out: ConversationMessage[] = [];
  for (const message of found.reverse()) {
    const prev = out.at(-1);
    if (prev?.role === message.role)
      out[out.length - 1] = { ...prev, text: `${prev.text}\n\n${message.text}` };
    else out.push(message);
  }
  return out;
}

// The rollout of a Codex session, named after the day it started and its id.
async function codexRollout(home: string, id: string): Promise<string | null> {
  const root = join(home, ".codex", "sessions");
  const glob = new Bun.Glob(`*/*/*/rollout-*-${id}.jsonl`);
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) return join(root, path);
  return null;
}

// The conversation of an agent terminal; null when it has none to read (a shell, Grok, a
// session not known yet, or a transcript that cannot be read).
export async function terminalConversation(
  home: string,
  t: TerminalInfo,
  limit = CONVERSATION.limit,
): Promise<ConversationMessage[] | null> {
  const id = t.agent?.sessionId;
  if (!id || !SESSION_ID.test(id)) return null;
  if (t.harness === "claude") {
    const path = await claudeTranscript(home, id);
    return path ? readConversation(path, claudeLine, limit) : null;
  }
  if (t.harness === "codex") {
    const path = await codexRollout(home, id);
    return path ? readConversation(path, codexLine, limit) : null;
  }
  return null;
}
