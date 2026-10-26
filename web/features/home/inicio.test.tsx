import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { terminal } from "../terminals/test-fixtures.ts";
import type { Source, SourceState } from "./data.ts";
import { buildInbox, coverage, type InboxSources } from "./inbox.ts";
import { Action } from "./inicio.tsx";
import { Lanes } from "./lanes.tsx";
import { pr, ticket } from "./test-fixtures.ts";

const tickets = [ticket("AB-7", "indeterminate"), ticket("AB-12", "new")];

const dataOf = (src: InboxSources, state: SourceState = { state: "ok" }) => {
  const sources: Source[] = [
    { id: "agents", label: "Agentes", ...state },
    { id: "prs", label: "GitHub", state: "ok" },
    { id: "tickets", label: "Jira", state: "ok" },
  ];
  const status = { agents: state.state, prs: "ok", tickets: "ok" } as const;
  return {
    inbox: buildInbox(src),
    terminals: src.terminals ?? [],
    sources,
    coverage: coverage(status, src.terminals),
    now: Date.parse("2026-10-01T09:00:00Z"),
  };
};

const render = (src: InboxSources, state?: SourceState, rows = tickets) =>
  renderWith(<Lanes data={dataOf(src, state)} tickets={rows} Action={Action} />);

describe("Inicio by ticket", () => {
  test("a lane holds its agent and PR, and each action navigates to where the item lives", async () => {
    const html = await render({
      terminals: [
        terminal({ id: "ask", ticket: "AB-7", agent: { sessionId: null, state: "needs_you" } }),
      ],
      prs: [pr(4, "review", undefined, "AB-7: retry the webhook")],
      tickets,
    });
    expect(html).toContain("AB-7");
    expect(html).toContain('href="/terminales?');
    expect(html).toContain('href="https://github.example.test/acme/api/pull/4"');
    // A PR keeps the review launcher beside its GitHub link.
    expect(html).toContain('aria-label="Revisar acme/api#4"');
    expect(html).toContain('href="/tickets/AB-12"');
    // A quiet ticket goes under the busy ones, never in between.
    expect(html.indexOf("Sin nada en marcha")).toBeGreaterThan(html.indexOf("AB-7"));
  });

  test("says there is nothing only when every source answered", async () => {
    expect(await render({}, { state: "ok" }, [])).toContain("Sin tickets ni agentes");
    const loading = await render({}, { state: "loading" }, []);
    expect(loading).not.toContain("Sin tickets ni agentes");
    const failed = await render(
      {},
      { state: "error", error: new Error("boom"), retry: () => {} },
      [],
    );
    expect(failed).not.toContain("Sin tickets ni agentes");
    expect(failed).toContain("No se han podido leer los agentes");
    // A partial source leaves the empty lane true only for what was read.
    const partial = await render({}, { state: "partial", problems: ["Sin datos de Codex"] }, []);
    expect(partial).not.toContain("Sin tickets ni agentes<");
    expect(partial).toContain("Sin tickets ni agentes en lo leído");
  });

  test("claims nothing is running or interrupting only when the sources behind it answered", async () => {
    const ok = await render({ tickets }, { state: "ok" });
    expect(ok).toContain("nada te interrumpe");
    expect(ok).toContain("Sin nada en marcha · 2");

    for (const state of [
      { state: "loading" },
      { state: "error", error: new Error("boom"), retry: () => {} },
    ] satisfies SourceState[]) {
      const html = await render({ tickets }, state);
      expect(html).not.toContain("nada te interrumpe");
      expect(html).not.toContain("0 tickets con algo en marcha");
      expect(html).toContain("faltan datos para saber si algo te interrumpe");
      expect(html).toContain("Sin nada en marcha (faltan datos) · 2");
    }

    // What was read is still a floor: one known interruption reads as "at least one".
    const asking = await render(
      { prs: [pr(4, "review", undefined, "AB-7: retry the webhook")], tickets },
      { state: "partial", problems: ["Sin datos de Codex"] },
    );
    expect(asking).toContain("al menos 1 cosa te interrumpe");
  });

  test("a lane past eight pieces keeps the rest behind a button", async () => {
    const terminals = Array.from({ length: 10 }, (_, i) =>
      terminal({
        id: `t${i}`,
        cwd: `/work/other-${i}`,
        agent: { sessionId: null, state: "working" },
      }),
    );
    const html = await render({ terminals, tickets }, undefined, tickets);
    expect(html).toContain("Ver las 10");
    expect(new Set(html.match(/other-\d/g)).size).toBe(8);
  });
});
