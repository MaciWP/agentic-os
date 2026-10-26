import { z } from "zod";

// The work bar: saved prompts marked `bar: true` in their frontmatter, dragged onto an agent's
// tile and sent there with the terminal's context filled in.

export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2");

// The top-level `key: value` lines of a document's frontmatter, in order. Unindented lines
// only: nested blocks (Claude's `metadata:`) are not fields.
export function frontmatterFields(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of FRONTMATTER.exec(text)?.[1]?.split(/\r?\n/) ?? []) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    const value = m?.[2] ? unquote(m[2].trim()) : "";
    if (m?.[1] && value) out.push([m[1], value]);
  }
  return out;
}

// A field that does not parse is left out rather than hiding the prompt from the desk.
const BarFields = z.object({
  bar: z.stringbool().catch(false),
  label: z.string().max(40).optional().catch(undefined),
  order: z.coerce.number().int().optional().catch(undefined),
});

export function barOf(text: string): { bar: boolean; label?: string; order?: number } {
  return BarFields.parse(Object.fromEntries(frontmatterFields(text).reverse()));
}

// The document with the frontmatter field `key` set to `value` (removed when empty), the rest of
// its frontmatter as it was. A value is kept to one line so it cannot end the block.
export function withField(text: string, key: string, value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const line = clean ? `${key}: ${clean}` : null;
  const fm = FRONTMATTER.exec(text);
  if (!fm) return line ? `---\n${line}\n---\n${text}` : text;
  const lines = (fm[1] ?? "").split(/\r?\n/).filter((l) => !l.startsWith(`${key}:`));
  return `---\n${[...lines, ...(line ? [line] : [])].join("\n")}\n---\n${text.slice(fm[0].length)}`;
}

export const withBar = (text: string, on: boolean) => withField(text, "bar", String(on));

// The document with its body replaced and its frontmatter kept.
export const withBody = (text: string, body: string) => (FRONTMATTER.exec(text)?.[0] ?? "") + body;

// What a bar button sends to: its label, else the prompt's title; its description says what it
// does.
export const BarButton = z.object({
  id: z.string(),
  title: z.string(),
  label: z.string().optional(),
  order: z.number().optional(),
  description: z.string().optional(),
});
export type BarButton = z.infer<typeof BarButton>;

export const PROMPT_VARIABLES = ["ticket", "objective", "branch", "cwd", "location"] as const;
export type PromptVariable = (typeof PROMPT_VARIABLES)[number];
export type PromptContext = Partial<Record<PromptVariable, string | null>>;

const VARIABLE = /\{\{(\w+)\}\}/g;
const isVariable = (name: string): name is PromptVariable =>
  (PROMPT_VARIABLES as readonly string[]).includes(name);

// The variables a body uses, once each. Any other `{{name}}` is the prompt's own text.
export const variablesIn = (body: string) => [
  ...new Set([...body.matchAll(VARIABLE)].map((m) => m[1] ?? "").filter(isVariable)),
];

// The body with each variable replaced by the terminal's value, or the names it has no value
// for. A value is one line with no control characters: it cannot break out of the prompt.
export function fillPrompt(
  body: string,
  ctx: PromptContext,
): { text: string } | { missing: PromptVariable[] } {
  const missing = variablesIn(body).filter((name) => !ctx[name]);
  if (missing.length > 0) return { missing };
  return {
    text: body.replace(VARIABLE, (all, name: string) =>
      isVariable(name)
        ? // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
          (ctx[name] ?? "").replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
        : all,
    ),
  };
}

// Why a terminal cannot take a bar prompt now, or null. A bar prompt is sent with Enter, so
// only an agent known to wait for its next message takes it: Codex reads `working` while it
// waits on a permission and Grok records no state (server/features/terminals/contract.ts), so
// only Codex's finished turn is told apart from a turn in progress.
export type PromptRefusal = "not_an_agent" | "no_state" | "agent_busy" | "agent_asks";

export function promptRefusal(t: {
  harness: string;
  agent?: { state: "working" | "needs_you" | null; asks?: string } | null;
}): PromptRefusal | null {
  if (t.harness !== "claude" && t.harness !== "codex")
    return t.harness === "grok" ? "no_state" : "not_an_agent";
  if (!t.agent?.state) return "no_state";
  if (t.agent.asks) return "agent_asks";
  return t.agent.state === "working" ? "agent_busy" : null;
}

export const PROMPT_REFUSAL_TEXT: Record<PromptRefusal | "missing", string> = {
  not_an_agent: "solo un agente Claude o Codex recibe botones",
  no_state: "no se sabe si este agente está libre",
  agent_busy: "el agente está trabajando",
  agent_asks: "el agente espera tu respuesta",
  missing: "a esta terminal le falta",
};
