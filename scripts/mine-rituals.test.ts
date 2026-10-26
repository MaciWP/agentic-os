import { describe, expect, test } from "bun:test";
import { MAX_CANDIDATES, mine, RECENT, templateOf, typedText } from "./mine-rituals.ts";

const typed = (text: string, session: string, at: string, extra: object = {}) =>
  JSON.stringify({
    type: "user",
    origin: { kind: "human" },
    promptSource: "typed",
    sessionId: session,
    timestamp: at,
    message: { role: "user", content: text },
    ...extra,
  });

describe("typedText", () => {
  test("keeps what the user typed, as a string or text blocks", () => {
    expect(typedText(typed("run the tests", "s1", "2026-10-01T10:00:00Z"))).toEqual({
      text: "run the tests",
      session: "s1",
      at: "2026-10-01T10:00:00Z",
    });
    const blocks = typed("", "s1", "t", {
      message: {
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      },
    });
    expect(typedText(blocks)?.text).toBe("a\nb");
  });

  test("drops tool results, meta, summaries, commands, side chains and the app's own prompts", () => {
    const at = "2026-10-01T10:00:00Z";
    const dropped = [
      typed("", "s", at, { message: { content: [{ type: "tool_result", content: "ok" }] } }),
      typed("caveat", "s", at, { isMeta: true }),
      typed("summary", "s", at, { isCompactSummary: true }),
      typed("<command-name>/clear</command-name>", "s", at),
      typed("from a subagent", "s", at, { isSidechain: true }),
      typed("note", "s", at, { origin: { kind: "task-notification" }, promptSource: "system" }),
      typed("Work on Jira ticket ABC-1.\nURL: x", "s", at),
      "not json",
    ];
    for (const line of dropped) expect(typedText(line)).toBeNull();
  });
});

describe("templateOf", () => {
  test("takes out tickets, URLs, paths, numbers and pasted blocks", () => {
    expect(
      templateOf(
        'Revisa ABC-12 en /Users/me/repo/src y https://x.test/pr/3 <pasted_content id="1">big</pasted_content id="1"> [Image #2] paso 2',
      ),
    ).toBe("revisa {{ticket}} en {{path}} y {{url}} paso {{n}}");
  });
});

describe("mine", () => {
  const lines = [
    typed("Ejecuta todos los tests de ABC-1", "s1", "2026-10-01T10:00:00Z"),
    typed("Ejecuta todos los tests de ABC-2", "s1", "2026-10-02T10:00:00Z"),
    typed("ejecuta todos los tests de ABC-3", "s2", "2026-10-03T10:00:00Z"),
    // Three times, but in one session only.
    typed("comprueba el contexto ahora mismo", "s1", "2026-10-01T11:00:00Z"),
    typed("comprueba el contexto ahora mismo", "s1", "2026-10-01T12:00:00Z"),
    typed("comprueba el contexto ahora mismo", "s1", "2026-10-01T13:00:00Z"),
    // Short replies never count.
    typed("sigue", "s1", "2026-10-01T14:00:00Z"),
    typed("sigue", "s2", "2026-10-02T14:00:00Z"),
    typed("sigue", "s3", "2026-10-03T14:00:00Z"),
  ];

  test("groups exact templates seen often enough in enough sessions", () => {
    expect(mine(lines).rituals).toEqual([
      {
        template: "ejecuta todos los tests de {{ticket}}",
        count: 3,
        sessions: 2,
        lastSeen: "2026-10-03T10:00:00Z",
        samples: ["ejecuta todos los tests de ABC-3", "Ejecuta todos los tests de ABC-2"],
      },
    ]);
  });

  test("the same lines in another order give the same JSON", () => {
    expect(JSON.stringify(mine([...lines].reverse()))).toBe(JSON.stringify(mine(lines)));
  });

  test("the rest are candidates: seen in two sessions or among the newest, one sample each", () => {
    expect(mine(lines).candidates).toEqual([
      {
        template: "comprueba el contexto ahora mismo",
        count: 3,
        sessions: 1,
        lastSeen: "2026-10-01T13:00:00Z",
        samples: ["comprueba el contexto ahora mismo"],
      },
    ]);
  });

  test("old prompts from one session drop out first, and the list is capped", () => {
    const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    const many = Array.from({ length: RECENT + 10 }, (_, i) =>
      typed(`one off prompt number ${"x".repeat(i + 1)} here`, `s${i}`, day(i)),
    );
    const { candidates } = mine(many);
    expect(candidates).toHaveLength(RECENT);
    expect(candidates.some((c) => c.lastSeen === day(0))).toBe(false);
    const shared = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => [
      typed(`shared prompt number ${"y".repeat(i + 1)} here`, "a", day(i)),
      typed(`shared prompt number ${"y".repeat(i + 1)} here`, "b", day(i)),
    ]).flat();
    expect(mine(shared).candidates).toHaveLength(MAX_CANDIDATES);
  });
});
