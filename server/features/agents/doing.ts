import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { jsonOrNull } from "../../json.ts";
import { scanBackwards } from "./discovery.ts";

// What an agent works on: the title its harness gave the session and the last prompt.
// `lastMessage`: the start of the last thing it said; `question`: what an AskUserQuestion it
// has not had answered asks (Claude only). `decides`: its last message ends the turn waiting on
// the user's decision (see asksDecision).
export type Doing = {
  title?: string;
  prompt?: string;
  lastMessage?: string;
  question?: string;
  decides?: true;
};
export const TITLE_CHARS = 80;
export const PROMPT_CHARS = 300;
export const MESSAGE_CHARS = 300;
// A transcript without either record is not read past this.
const DOING_BYTES = 4 << 20;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
// An agent's message as one line of plain text: bold and code marks dropped.
const said = (text: string) => oneLine(text.replace(/\*\*|`/g, ""), MESSAGE_CHARS);

// The house style (Poneglyph) ends a turn that waits on the user's decision with a line
// "**Espera tu decisión:** …"; a turn that only finished has none. Neither harness records
// the difference, so the text is the signal.
const DECISION = /^[\s*_>-]*espera tu decisión\b/imu;
export const asksDecision = (text: string) => DECISION.test(text);

const ClaudeText = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z.array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        name: z.string().optional(),
        input: z.unknown().optional(),
      }),
    ),
  }),
});

const AskInput = z.looseObject({
  questions: z.array(z.looseObject({ question: z.string().min(1) })).min(1),
});
// The first question, and how many more the same call asks.
const askText = ({ questions }: z.infer<typeof AskInput>) =>
  oneLine(
    `${questions[0]?.question ?? ""}${questions.length > 1 ? ` (+${questions.length - 1})` : ""}`,
    MESSAGE_CHARS,
  );

const ClaudeTitle = z.looseObject({ type: z.literal("ai-title"), aiTitle: z.string().min(1) });
const ClaudePrompt = z.looseObject({
  type: z.literal("last-prompt"),
  lastPrompt: z.string().min(1),
});

// Claude writes both records to the transcript on every turn; its last text says whether
// the turn waits on a decision. An AskUserQuestion after that text and with no tool result
// after it is the question still open.
export async function claudeDoing(path: string): Promise<Doing> {
  const doing: Doing = {};
  let spoke = false;
  let answered = false;
  await scanBackwards(
    path,
    (line) => {
      if (!spoke && line.includes('"assistant"')) {
        const r = ClaudeText.safeParse(jsonOrNull(line));
        const content = r.success ? r.data.message.content : [];
        if (!answered && !doing.question) {
          const ask = content.find((c) => c.type === "tool_use" && c.name === "AskUserQuestion");
          const input = AskInput.safeParse(ask?.input);
          if (input.success) doing.question = askText(input.data);
        }
        const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
        if (text.trim()) {
          spoke = true;
          doing.lastMessage = said(text);
          if (asksDecision(text)) doing.decides = true;
        }
      } else if (!spoke && line.includes('"type":"user"') && line.includes('"tool_result"')) {
        answered = true;
      } else if (!doing.title && line.includes('"ai-title"')) {
        const r = ClaudeTitle.safeParse(jsonOrNull(line));
        if (r.success) doing.title = oneLine(r.data.aiTitle, TITLE_CHARS);
      } else if (!doing.prompt && line.includes('"last-prompt"')) {
        const r = ClaudePrompt.safeParse(jsonOrNull(line));
        if (r.success) doing.prompt = oneLine(r.data.lastPrompt, PROMPT_CHARS);
      }
      return Boolean(doing.title && doing.prompt && spoke);
    },
    DOING_BYTES,
  );
  return doing;
}

const CodexUserMessage = z.looseObject({
  type: z.literal("event_msg"),
  payload: z.looseObject({
    type: z.literal("item_completed"),
    item: z.looseObject({
      type: z.literal("UserMessage"),
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
    }),
  }),
});

const CodexTurnEnd = z.looseObject({
  type: z.literal("event_msg"),
  payload: z.looseObject({
    type: z.literal("task_complete"),
    last_agent_message: z.string().nullish(),
  }),
});

// Codex keeps no session title; the last message the user typed says what it works on. The
// end of the turn it started carries the agent's last message.
export async function codexDoing(path: string): Promise<Doing> {
  const doing: Doing = {};
  let ended = false;
  await scanBackwards(
    path,
    (line) => {
      if (!ended && line.includes('"task_complete"')) {
        const r = CodexTurnEnd.safeParse(jsonOrNull(line));
        ended = r.success;
        const text = r.success ? (r.data.payload.last_agent_message ?? "") : "";
        if (text.trim()) doing.lastMessage = said(text);
        if (asksDecision(text)) doing.decides = true;
        return false;
      }
      if (!line.includes('"UserMessage"')) return false;
      const r = CodexUserMessage.safeParse(jsonOrNull(line));
      const text = r.success ? r.data.payload.item.content.map((c) => c.text ?? "").join(" ") : "";
      if (text.trim()) doing.prompt = oneLine(text, PROMPT_CHARS);
      return Boolean(doing.prompt);
    },
    DOING_BYTES,
  );
  return doing;
}

// Claude's transcript for a session, in whichever project folder Claude filed it.
export async function claudeTranscript(home: string, sessionId: string): Promise<string | null> {
  const root = join(home, ".claude", "projects");
  for (const dir of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, dir, `${sessionId}.jsonl`);
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}
