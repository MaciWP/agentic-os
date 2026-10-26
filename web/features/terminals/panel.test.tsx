import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import {
  phaseOf,
  rowText,
  standingOf,
  standingRank,
  TerminalMarks,
  terminalHover,
  terminalState,
} from "./panel.tsx";
import type { TerminalInfo } from "./queries.ts";
import { terminal } from "./test-fixtures.ts";

describe("rowText", () => {
  test("the user's name wins over the agent's title, then its last prompt, then the harness", () => {
    const agent = { sessionId: "s", state: null, title: "T", prompt: "p" } as const;
    expect(rowText(terminal({ name: "mine", agent }))).toBe("mine");
    expect(rowText(terminal({ agent }))).toBe("T");
    expect(rowText(terminal({ agent: { ...agent, title: undefined } }))).toBe("p");
    expect(rowText(terminal({}))).toBe("Claude");
  });

  test("the hover names the harness, the state and the last prompt", () => {
    const t = terminal({ agent: { sessionId: "s", state: "working", title: "Fix", prompt: "go" } });
    expect(terminalHover(t, "trabajando")).toBe("Claude\ntrabajando\nÚltimo prompt: go");
  });
});

describe("TerminalMarks", () => {
  const marks = (t: TerminalInfo, needsYou: boolean) =>
    renderWith(<TerminalMarks t={t} needsYou={needsYou} state={terminalState(t, needsYou)} />);
  const agent = (over: Partial<NonNullable<TerminalInfo["agent"]>>) =>
    terminal({ agent: { sessionId: "s", state: "working", ...over } });

  test("the phase comes first, the harness as its logo with its name only in the title", async () => {
    const html = await marks(agent({ title: "Fix tabs" }), false);
    expect(html.indexOf('title="trabajando"')).toBeLessThan(html.indexOf('title="Claude"'));
    expect(html).toContain('data-phase="working"');
    // It turns on the shared timer (web/motion.ts), never on an endless CSS loop.
    expect(html).toContain('data-spin=""');
    expect(html).not.toContain("animate-spin");
    expect(html).toContain('data-harness="claude"');
    expect(html).not.toContain(">Claude<");
  });

  test("each phase has its own colour and words", () => {
    const cases: [TerminalInfo, string, string][] = [
      [agent({}), "working", "trabajando"],
      [agent({ state: "needs_you", asks: "question" }), "asks", "te pregunta"],
      [agent({ state: "needs_you", asks: "permission" }), "asks", "pide permiso"],
      [agent({ state: "needs_you" }), "turn", "turno terminado"],
      [terminal({ harness: "shell" }), "running", "en marcha"],
      [terminal({ state: "exited", exitCode: 0 }), "exited", "terminada"],
      [terminal({ state: "exited", exitCode: 2 }), "failed", "terminada con código 2"],
      [terminal({ state: "lost" }), "failed", "perdida"],
    ];
    for (const [t, key, label] of cases) expect(phaseOf(t)).toMatchObject({ key, label });
    expect(new Set(cases.map(([t]) => phaseOf(t).color)).size).toBe(6);
  });

  test("a terminal that needs the user pulses a few times; an ended one says so in words", async () => {
    const html = await marks(agent({ state: "needs_you" }), true);
    expect(html).toContain('data-phase="turn"');
    expect(html).toContain("motion-safe:animate-attention");
    expect(html).not.toContain("animate-pulse");
    expect(await marks(agent({ state: "needs_you" }), false)).not.toContain("animate-attention");
    expect(terminalState(terminal({ state: "exited" }), true)).toBe("terminada · te necesita");
  });
});

describe("standingOf", () => {
  const needs = (asks?: "question" | "permission") =>
    ({ sessionId: "s", state: "needs_you", ...(asks && { asks }) }) as const;
  test("a question waits whether or not it was seen; a turn waits quietly once seen", () => {
    const none = new Set<string>();
    expect(standingOf(terminal({ agent: needs("question") }), none)).toEqual({
      group: "waits",
      kind: "asks",
      seen: false,
    });
    expect(standingOf(terminal({ agent: needs() }), new Set(["t1"]))).toMatchObject({
      kind: "turn",
      seen: false,
    });
    expect(standingOf(terminal({ agent: needs() }), none)).toMatchObject({
      kind: "turn",
      seen: true,
    });
  });
  test("a failure waits until seen, then it is done; a working agent and a shell run", () => {
    const failed = terminal({ state: "exited", exitCode: 1 });
    expect(standingOf(failed, new Set(["t1"]))).toMatchObject({ group: "waits", kind: "failed" });
    expect(standingOf(failed, new Set())).toEqual({ group: "done" });
    expect(
      standingOf(terminal({ agent: { sessionId: "s", state: "working" } }), new Set()),
    ).toEqual({ group: "runs", working: true });
    expect(standingOf(terminal({}), new Set())).toEqual({ group: "runs", working: false });
  });
  test("the rank puts a failure, then a question, then an unseen turn first", () => {
    const ranks = [
      { group: "done" },
      { group: "runs", working: false },
      { group: "waits", kind: "turn", seen: true },
      { group: "waits", kind: "asks", seen: false },
      { group: "runs", working: true },
      { group: "waits", kind: "failed", seen: false },
      { group: "waits", kind: "turn", seen: false },
    ] as const;
    expect(ranks.map(standingRank)).toEqual([6, 5, 3, 1, 4, 0, 2]);
  });
});
