import { z } from "zod";
import { jsonOrNull } from "../../json.ts";
import { run } from "../../run.ts";
import { clip, n, type Parsed, type Usage } from "./parsed.ts";

const GROK_TIMEOUT_MS = 15_000;

const GrokTokens = z.looseObject({
  inputTokens: n,
  cachedReadTokens: n.optional(),
  cacheCreationTokens: n.optional(),
  outputTokens: n,
});
export const GrokUsage = z.looseObject({
  sessionId: z.string().min(1),
  turns: z.array(
    z.looseObject({
      turnNumber: z.number().int(),
      endedAt: z.string().nullish(),
      modelUsage: z.record(z.string(), GrokTokens).catch({}),
    }),
  ),
});
const GrokEvent = z.looseObject({
  ts: z.string(),
  type: z.literal("tool_started"),
  tool_name: z.string().min(1),
});

// One row per turn and model; Grok, like Codex, counts the cache inside the input.
export function grokUsage(
  report: z.infer<typeof GrokUsage>,
  where: { cwd: string; at: string },
): Usage[] {
  return report.turns.flatMap((t) =>
    Object.entries(t.modelUsage).map(([model, u]) => {
      const cacheRead = u.cachedReadTokens ?? 0;
      const cacheWrite = u.cacheCreationTokens ?? 0;
      return {
        id: `${report.sessionId}:${t.turnNumber}:${model}`,
        sessionId: report.sessionId,
        cwd: where.cwd,
        branch: "",
        agent: "",
        skill: "",
        model: clip(model),
        at: t.endedAt ?? where.at,
        input: Math.max(0, u.inputTokens - cacheRead - cacheWrite),
        cacheRead,
        cacheWrite,
        cacheWrite1h: 0,
        output: u.outputTokens,
      };
    }),
  );
}

// Grok's tool calls carry no id; its time and name are one.
export function grokLines(lines: string[], where: { sessionId: string; cwd: string }): Parsed {
  const out: Parsed = { usage: [], events: [], drop: [], checks: [] };
  for (const line of lines) {
    if (!line.includes('"tool_started"')) continue;
    const e = GrokEvent.safeParse(jsonOrNull(line));
    if (!e.success) continue;
    out.events.push({
      ...where,
      id: `${e.data.ts}:${e.data.tool_name}`,
      kind: "tool",
      branch: "",
      agent: "",
      name: clip(e.data.tool_name),
      detail: "",
      ms: null,
      at: e.data.ts,
    });
  }
  return out;
}

// null: Grok recorded no usage for the session (an older one, or one never used).
export function grokUsageCli(bin: string) {
  return async (sessionId: string): Promise<unknown> => {
    const r = await run([bin, "usage", sessionId], { timeoutMs: GROK_TIMEOUT_MS });
    if (r.code === 0) return JSON.parse(r.stdout);
    if (r.stderr.includes("No usage recorded")) return null;
    const why = r.timedOut ? `timed out after ${GROK_TIMEOUT_MS / 1000} s` : r.stderr.trim();
    throw new Error(`grok usage ${sessionId} failed: ${why.slice(0, 200)}`);
  };
}
