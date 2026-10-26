import { z } from "zod";
import { jsonOrNull } from "../../json.ts";
import { clip, n, type Parsed, type Usage } from "./parsed.ts";

const ClaudeTokens = z.looseObject({
  input_tokens: n,
  cache_creation_input_tokens: n.optional(),
  cache_read_input_tokens: n.optional(),
  output_tokens: n,
  cache_creation: z
    .looseObject({ ephemeral_1h_input_tokens: n.optional() })
    .optional()
    .catch(undefined),
});
// When the advisor runs, one message holds several API calls: the top-level counts are the sum
// of the `message` iterations, and the `advisor_message` ones are counted nowhere else.
const Iteration = ClaudeTokens.extend({ type: z.string(), model: z.string().optional() });
const ClaudeUsage = ClaudeTokens.extend({
  iterations: z.array(Iteration).nullish().catch(undefined),
});
const Block = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
});
const ClaudeLine = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  timestamp: z.string(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
});
const AssistantLine = ClaudeLine.extend({
  type: z.literal("assistant"),
  attributionSkill: z.string().nullish(),
  advisorModel: z.string().nullish(),
  effort: z.string().nullish(),
  perTurnEffort: z.string().nullish(),
  message: z.looseObject({
    id: z.string(),
    model: z.string(),
    usage: ClaudeUsage.optional(),
    content: z.array(z.unknown()).catch([]),
  }),
});
const UserLine = ClaudeLine.extend({
  type: z.literal("user"),
  message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
});
const ToolResult = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.unknown(),
});
const AttachmentLine = ClaudeLine.extend({
  type: z.literal("attachment"),
  uuid: z.string(),
  attachment: z.looseObject({
    type: z.string(),
    hookName: z.string().optional(),
    command: z.string().optional(),
    stderr: z.string().optional(),
    durationMs: z.number().optional(),
  }),
});

// Claude Code's own running cost of the session, written again as it grows; the last one holds.
// Not documented: read loosely, and a line that does not fit is skipped.
const CostState = z.looseObject({
  type: z.literal("cost-state"),
  // Epoch ms; the bound keeps toISOString from throwing.
  startTime: z.number().nonnegative().max(8.64e15),
  totalCostUSD: z.number().nonnegative(),
  modelUsage: z.record(z.string(), z.looseObject({ costUSD: z.number().catch(0) })).catch({}),
});

const HOOK_OUTCOME: Record<string, string> = {
  hook_success: "ok",
  hook_non_blocking_error: "error",
  hook_blocking_error: "block",
  hook_cancelled: "timeout",
};
const COMMAND = /<command-name>(\/[^<\s]{1,80})<\/command-name>/;
// "PreToolUse:Bash hook error: [security-gate] …": the hook that blocked a tool call.
const HOOK_BLOCK = /^(\w+(?::[\w.-]+)?) hook error:\s*(?:\[([\w.-]{1,60})\])?/;
// Bounded: hook commands can be long shell scripts, and an open `[\w.-]+` backtracks over them.
const SCRIPT = /(?<![\w.-])([\w-][\w.-]{0,80}\.(?:ts|mts|js|mjs|sh|py))(?![\w.-])/;

const SkillInput = z.looseObject({ skill: z.string().min(1) });
const AgentInput = z.looseObject({
  subagent_type: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const first = content.find(
    (c): c is { text: string } => typeof (c as { text?: unknown })?.text === "string",
  );
  return first?.text ?? "";
};

// The lines worth parsing: the rest (file snapshots, listings, big tool outputs) are skipped
// before JSON.parse, which is most of the time spent.
const claudeWanted = (line: string) =>
  line.includes('"type":"assistant"') ||
  line.includes('"type":"cost-state"') ||
  (line.includes('"type":"attachment"') && line.includes('"hook_')) ||
  (line.includes('"type":"user"') &&
    (line.includes("<command-name>") || line.includes("hook error")));

export function claudeLines(
  lines: string[],
  file: { sessionId: string; agent: string },
  state: ClaudeState,
): Parsed {
  const out: Parsed = { usage: [], events: [], drop: [], checks: [] };
  // Where the line happened; a line without cwd or branch keeps the last ones seen.
  const at = (d: z.infer<typeof ClaudeLine>) => {
    if (d.cwd) state.cwd = d.cwd;
    if (d.gitBranch !== undefined) state.branch = d.gitBranch;
    return { ...file, cwd: state.cwd, branch: state.branch, at: d.timestamp };
  };
  for (const line of lines) {
    if (!claudeWanted(line)) continue;
    const json = jsonOrNull(line);
    // One schema per line, picked by its type: zod is most of the cost of a backfill.
    const type = (json as { type?: unknown } | null)?.type;
    if (type === "assistant") {
      const a = AssistantLine.safeParse(json);
      if (a.success) claudeAssistant(a.data, at(a.data), out);
    } else if (type === "user") {
      const u = UserLine.safeParse(json);
      if (u.success) claudeUser(u.data, at(u.data), out);
    } else if (type === "cost-state") {
      // A subagent's file is part of its parent's session, whose own file holds the count.
      const c = file.agent ? null : CostState.safeParse(json);
      if (!c?.success) continue;
      out.checks.push({
        sessionId: file.sessionId,
        startTime: new Date(c.data.startTime).toISOString(),
        totalUsd: c.data.totalCostUSD,
        models: Object.fromEntries(
          Object.entries(c.data.modelUsage).map(([model, m]) => [clip(model), m.costUSD]),
        ),
      });
    } else if (type === "attachment") {
      const a = AttachmentLine.safeParse(json);
      const outcome = a.success ? HOOK_OUTCOME[a.data.attachment.type] : undefined;
      if (!a.success || !outcome) continue;
      const h = a.data.attachment;
      const script = SCRIPT.exec(h.command ?? "")?.[1] ?? SCRIPT.exec(h.stderr ?? "")?.[1];
      out.events.push({
        ...at(a.data),
        id: a.data.uuid,
        kind: "hook",
        name: clip(script ?? h.hookName ?? "hook"),
        detail: outcome,
        ms: h.durationMs === undefined ? null : Math.round(h.durationMs),
      });
    }
  }
  return out;
}

type Where = Pick<Usage, "sessionId" | "agent" | "cwd" | "branch" | "at">;

function claudeTokens(u: z.infer<typeof ClaudeTokens>) {
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return {
    input: u.input_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: write - write1h,
    cacheWrite1h: write1h,
    output: u.output_tokens,
  };
}

// A level is a short lowercase word; anything else is not one.
const EFFORT = /^[a-z]{1,12}$/;

function claudeAssistant(line: z.infer<typeof AssistantLine>, where: Where, out: Parsed): void {
  const m = line.message;
  const u = m.usage;
  // A message spans several lines with the same id and usage; the id keeps one row.
  if (u && m.model !== "<synthetic>") {
    const skill = clip(line.attributionSkill ?? "");
    // The turn's level; the advisor runs at its own, which the line does not say.
    const level = EFFORT.exec(line.effort ?? line.perTurnEffort ?? "")?.[0];
    const effort = level ? { effort: level } : {};
    const iterations = u.iterations ?? [];
    if (!iterations.some((i) => i.type === "advisor_message")) {
      out.usage.push({
        ...where,
        id: m.id,
        skill,
        model: clip(m.model),
        ...claudeTokens(u),
        ...effort,
      });
    } else {
      // One row per real call, so each keeps its own prompt size. The first call keeps the
      // message id, which replaces the summed row an older read wrote under it.
      let first = true;
      iterations.forEach((it, i) => {
        const advisor = it.type === "advisor_message";
        if (!advisor && it.type !== "message") return;
        const id = advisor ? `${m.id}:advisor:${i}` : first ? m.id : `${m.id}:${i}`;
        if (!advisor) first = false;
        const model = advisor ? (it.model ?? line.advisorModel ?? m.model) : m.model;
        out.usage.push({
          ...where,
          id,
          skill,
          model: clip(model),
          ...claudeTokens(it),
          ...(advisor ? { role: "advisor" as const } : effort),
        });
      });
    }
  }
  for (const raw of m.content) {
    const b = Block.safeParse(raw);
    if (!b.success || b.data.type !== "tool_use" || !b.data.id || !b.data.name) continue;
    const ev = { ...where, id: b.data.id, detail: "", ms: null };
    out.events.push({ ...ev, kind: "tool", name: clip(b.data.name) });
    const skill = b.data.name === "Skill" ? SkillInput.safeParse(b.data.input) : null;
    if (skill?.success) out.events.push({ ...ev, kind: "skill", name: clip(skill.data.skill) });
    if (b.data.name === "Agent" || b.data.name === "Task") {
      const a = AgentInput.safeParse(b.data.input);
      const input = a.success ? a.data : {};
      out.events.push({
        ...ev,
        kind: "subagent",
        name: clip(input.subagent_type ?? "general-purpose"),
        detail: clip(input.model ?? ""),
      });
    }
  }
}

function claudeUser(line: z.infer<typeof UserLine>, where: Where, out: Parsed): void {
  const content = line.message.content;
  const command = typeof content === "string" ? COMMAND.exec(content) : null;
  if (command?.[1] && line.uuid)
    out.events.push({
      ...where,
      id: line.uuid,
      kind: "command",
      name: command[1],
      detail: "",
      ms: null,
    });
  for (const raw of Array.isArray(content) ? content : []) {
    const r = ToolResult.safeParse(raw);
    if (!r.success || !r.data.is_error) continue;
    const block = HOOK_BLOCK.exec(textOf(r.data.content));
    if (!block?.[1]) continue;
    out.events.push({
      ...where,
      id: `${r.data.tool_use_id}:hook`,
      kind: "hook",
      name: block[2] ?? block[1],
      detail: "block",
      ms: null,
    });
  }
}

// The state a reader keeps between reads of one file, saved with its offset.
export const ClaudeState = z.object({ cwd: z.string(), branch: z.string() });
export type ClaudeState = z.infer<typeof ClaudeState>;
