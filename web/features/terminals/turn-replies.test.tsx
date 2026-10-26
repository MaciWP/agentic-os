import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import type { TerminalInfo } from "./queries.ts";
import { terminal } from "./test-fixtures.ts";
import { TurnReplies } from "./turn-replies.tsx";

const bar = {
  buttons: ["Qué falta", "Qué propones", "Investiga", "No funciona", "Seguro"].map((label, i) => ({
    id: `prompts:${i}.md`,
    title: label,
    label,
  })),
};
const agent = (
  over: Partial<NonNullable<TerminalInfo["agent"]>>,
  harness: TerminalInfo["harness"] = "claude",
) => terminal({ harness, agent: { sessionId: "s", state: "needs_you", ...over } });
const render = (t: TerminalInfo, limit?: number, buttons = bar) =>
  renderWith(<TurnReplies t={t} limit={limit} />, [[["memory", "bar"], buttons]]);

describe("TurnReplies", () => {
  test("a finished turn offers the bar's first rituals, in its order", async () => {
    const html = await render(agent({}));
    expect(html).toContain('aria-label="Responder con un ritual"');
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html.indexOf("Qué falta")).toBeLessThan(html.indexOf("Qué propones"));
    expect(html).not.toContain("Seguro");
    expect((await render(agent({}), 2)).match(/<button/g)).toHaveLength(2);
  });

  test("nothing while the agent works, asks, has no known state or the bar is empty", async () => {
    expect(await render(agent({ state: "working" }))).toBe("");
    expect(await render(agent({ asks: "question" }))).toBe("");
    expect(await render(agent({}, "grok"))).toBe("");
    expect(await render(terminal({ harness: "shell" }))).toBe("");
    expect(await render({ ...agent({}), state: "exited" })).toBe("");
    expect(await render(agent({}), undefined, { buttons: [] })).toBe("");
  });
});
