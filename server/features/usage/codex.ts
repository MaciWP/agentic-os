import { z } from "zod";
import { jsonOrNull } from "../../json.ts";
import { clip, n, type Parsed } from "./parsed.ts";

const CodexTokens = z.looseObject({
  input_tokens: n,
  cached_input_tokens: n.optional(),
  cache_write_input_tokens: n.optional(),
  output_tokens: n,
});
const CodexLine = z.looseObject({
  timestamp: z.string(),
  type: z.string(),
  payload: z.looseObject({ type: z.string().optional() }).catch({}),
});
const SessionMeta = z.looseObject({
  id: z.string().min(1),
  cwd: z.string().min(1),
  git: z.looseObject({ branch: z.string().optional() }).nullish(),
});
const TurnContext = z.looseObject({ model: z.string().optional(), cwd: z.string().optional() });
const UsageRecord = z.looseObject({
  response_id: z.string().optional(),
  turn_id: z.string().optional(),
  usage: CodexTokens,
});
const TokenCount = z.looseObject({
  info: z.looseObject({ total_token_usage: CodexTokens }).nullish(),
});
const ToolCall = z.looseObject({
  type: z.enum(["function_call", "custom_tool_call"]),
  name: z.string().min(1),
  call_id: z.string().optional(),
  id: z.string().optional(),
});

// Codex counts the cache inside the input; the row keeps them apart, as Claude does.
const codexTokens = (t: z.infer<typeof CodexTokens>) => {
  const cacheRead = t.cached_input_tokens ?? 0;
  const cacheWrite = t.cache_write_input_tokens ?? 0;
  return {
    input: Math.max(0, t.input_tokens - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    output: t.output_tokens,
  };
};

const codexWanted = (line: string) =>
  line.includes('"session_meta"') ||
  line.includes('"turn_context"') ||
  line.includes('"token_usage_record"') ||
  line.includes('"token_count"') ||
  line.includes('"function_call"') ||
  line.includes('"custom_tool_call"');

export function codexLines(lines: string[], state: CodexState): Parsed {
  const out: Parsed = { usage: [], events: [], drop: [], checks: [] };
  const totalId = () => `${state.sessionId}:total`;
  for (const line of lines) {
    if (!codexWanted(line)) continue;
    const l = CodexLine.safeParse(jsonOrNull(line));
    if (!l.success) continue;
    const { timestamp: at, type, payload } = l.data;
    if (type === "session_meta") {
      const meta = SessionMeta.safeParse(payload);
      if (meta.success) {
        state.sessionId = meta.data.id;
        state.cwd = meta.data.cwd;
        state.branch = meta.data.git?.branch ?? "";
      }
      continue;
    }
    if (!state.sessionId) continue;
    const where = {
      sessionId: state.sessionId,
      cwd: state.cwd,
      branch: state.branch,
      agent: "",
      at,
    };
    if (type === "turn_context") {
      const t = TurnContext.safeParse(payload);
      if (t.success) {
        state.model = t.data.model ?? state.model;
        state.cwd = t.data.cwd ?? state.cwd;
      }
    } else if (type === "token_usage_record") {
      const r = UsageRecord.safeParse(payload);
      const id = r.success ? (r.data.response_id ?? r.data.turn_id) : undefined;
      if (!r.success || !id) continue;
      if (!state.records) out.drop.push(totalId());
      state.records = true;
      out.usage.push({
        ...where,
        id,
        skill: "",
        model: clip(state.model || "unknown"),
        ...codexTokens(r.data.usage),
      });
    } else if (type === "event_msg" && payload.type === "token_count" && !state.records) {
      // Older rollouts carry only the running total: one row, replaced as it grows.
      // ponytail: priced at the session's last model; a model switch mid-session misprices it.
      const t = TokenCount.safeParse(payload);
      const total = t.success ? t.data.info?.total_token_usage : undefined;
      if (total)
        out.usage.push({
          ...where,
          id: totalId(),
          skill: "",
          model: clip(state.model || "unknown"),
          ...codexTokens(total),
        });
    } else if (type === "response_item") {
      const call = ToolCall.safeParse(payload);
      const id = call.success ? (call.data.call_id ?? call.data.id) : undefined;
      if (call.success && id)
        out.events.push({
          ...where,
          id,
          kind: "tool",
          name: clip(call.data.name),
          detail: "",
          ms: null,
        });
    }
  }
  return out;
}

export const CodexState = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  branch: z.string(),
  model: z.string(),
  // Per-response records seen: the cumulative total is then never used.
  records: z.boolean(),
});
export type CodexState = z.infer<typeof CodexState>;
