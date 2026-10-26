import { describe, expect, test } from "bun:test";
import { failQuery, renderWith } from "../../test-render.tsx";
import { ticket as ticketRow } from "../home/test-fixtures.ts";
import { BRING_MIME, startBring } from "../terminals/bring.ts";
import type { TerminalInfo } from "../terminals/queries.ts";
import { terminal } from "../terminals/test-fixtures.ts";
import type { TicketRow } from "../tickets/groups.ts";
import { ticketEnv } from "./queries.ts";
import { TicketsList } from "./sources.tsx";
import { projects } from "./test-fixtures.ts";

const ticket = (key: string) => ({
  ...ticketRow(key, "indeterminate"),
  summary: `Resumen ${key}`,
  status: { id: "3", name: "En curso", category: "indeterminate" },
});

// The fixture's one env, typed as present.
function envA() {
  const env = projects().envs.items[0];
  if (!env) throw new Error("the fixture has an env");
  return env;
}

const render = (keys: string[], terminals: TerminalInfo[] = [], p = projects()) =>
  renderWith(<TicketsList />, [
    [["tickets"], { jql: "q", tickets: keys.map(ticket) }],
    [["tickets", "team"], { jql: "q", tickets: [], me: "me" }],
    [["projects"], p],
    [["terminals"], { terminals, locations: [] }],
  ]);

describe("ticketEnv", () => {
  test("finds the env on the ticket's branch or named after it", () => {
    expect(ticketEnv(projects(), "ABC-1")).toMatchObject({ name: "env-a" });
    const named = projects({
      items: [{ ...envA(), name: "abc-2", branch: null }],
    });
    expect(ticketEnv(named, "ABC-2")).toMatchObject({ name: "abc-2" });
    expect(ticketEnv(projects(), "ABC-9")).toBeUndefined();
  });

  test("a failed provider's empty list is unknown, never 'no env'", () => {
    expect(ticketEnv(projects({ items: [], error: "envctl timed out" }), "ABC-1")).toBe("unknown");
  });
});

describe("teammates among the tickets", () => {
  const row = (key: string, status: string, assignee: string | null = "ana"): TicketRow => ({
    ...ticketRow(key, "indeterminate"),
    status: { id: "1", name: status, category: "indeterminate" },
    assignee: assignee
      ? { accountId: assignee, displayName: assignee === "me" ? "Oriol" : "Ana Ruiz" }
      : null,
  });
  const mine = [row("ABC-1", "QUÉ", "me"), row("ABC-2", "Release Ready", "me")];
  const show = (team?: TicketRow[], own = mine, fail = false, disabled = false) =>
    renderWith(
      <TicketsList />,
      [
        [["tickets"], { jql: "q", tickets: own }],
        ...(team
          ? [
              [
                ["tickets", "team"],
                disabled ? { disabled: true } : { jql: "q", tickets: team, me: "me" },
              ] as [unknown[], unknown],
            ]
          : []),
        [["projects"], projects({ configured: false, items: [] })],
        [["terminals"], { terminals: [], locations: [] }],
      ],
      fail ? failQuery(["tickets", "team"], undefined, "Jira 503") : undefined,
    );

  test("keeps every personal ticket and adds only assigned teammates in the three review states", async () => {
    const html = await show([
      ...mine,
      row("ABC-3", "En curso"),
      row("ABC-4", "Pull Request"),
      row("ABC-5", "In Product Review"),
      row("ABC-6", "QUÉ"),
      row("ABC-7", "Release Ready"),
      row("ABC-8", "En curso", null),
      row("ABC-9", "Tareas por hacer"),
      row("ABC-10", "BACKLOG"),
      row("ABC-11", "Done"),
      row("ABC-12", "Pull Request", "me"),
    ]);
    for (const key of ["ABC-1", "ABC-2", "ABC-3", "ABC-4", "ABC-5"])
      expect(html.split(`href="/tickets/${key}`).length - 1).toBe(1);
    for (const key of ["ABC-6", "ABC-7", "ABC-8", "ABC-9", "ABC-10", "ABC-11", "ABC-12"])
      expect(html).not.toContain(`href="/tickets/${key}`);
    expect(html.match(/>Revisar</g)).toHaveLength(3);
    expect(html).toContain("Ana Ruiz");
  });

  test("teammates appear even with no personal tickets", async () => {
    const html = await show([row("ABC-3", "Pull Request")], []);
    expect(html).toContain("ABC-3");
    expect(html).not.toContain("No hay tickets");
  });

  test("loading or failed team reads keep mine visible and never claim the list is empty", async () => {
    const loading = await show();
    expect(loading).toContain("ABC-1");
    expect(loading).toContain("Cargando tickets del equipo");
    const failed = await show(undefined, mine, true);
    expect(failed).toContain("ABC-1");
    expect(failed).toContain("Jira 503");
    expect(failed).toContain("Reintentar");
    for (const html of [await show(undefined, []), await show(undefined, [], true)])
      expect(html).not.toContain("No hay tickets");
  });

  test("an empty result is shown only after both reads succeed", async () => {
    expect(await show([row("ABC-6", "QUÉ")], [])).toContain("No hay tickets");
    expect(await show([], [], false, true)).not.toContain("No hay tickets");
  });
});

describe("TicketsList", () => {
  test("a ticket with an env shows its state; one without offers the create", async () => {
    const html = await render(["ABC-1", "ABC-9"]);
    expect(html).toMatch(/env-a<\/span><span[^>]*bg-ok\/15[^>]*>.*?levantado/);
    expect(html).not.toContain('aria-label="Levantar el entorno de ABC-1"');
    expect(html).toContain('aria-label="Crear el entorno de ABC-9"');
    expect(html).toContain('title="Crea abc-9 con backend, frontend en la rama feature/ABC-9"');
    expect(html).not.toContain('aria-label="Crear el entorno de ABC-1"');
  });

  test("a stopped env offers Levantar", async () => {
    const env = envA();
    const stopped = projects({
      items: [{ ...env, repos: env.repos.map((r) => ({ ...r, servers: "stopped" })) }],
    });
    const html = await render(["ABC-1"], [], stopped);
    expect(html).toContain('aria-label="Levantar el entorno de ABC-1"');
  });

  test("a create still running reads as busy, with no second create", async () => {
    const creating = terminal({ harness: "env", action: "create", env: "abc-9", location: "envs" });
    const html = await render(["ABC-9"], [creating]);
    expect(html).toContain("trabajando…");
    expect(html).not.toContain('aria-label="Crear el entorno de ABC-9"');
  });

  test("a failed env provider says so and offers no create", async () => {
    const failed = projects({ items: [], error: "envctl timed out" });
    const html = await render(["ABC-1"], [], failed);
    expect(html).not.toContain("Crear entorno");
    expect(html).toContain("No se pudieron leer los entornos");
    expect(html).toContain("envctl timed out");
  });

  test("no env provider, no env actions", async () => {
    const html = await render(["ABC-9"], [], projects({ configured: false, items: [] }));
    expect(html).not.toContain("Crear entorno");
  });
});

describe("dragging a row", () => {
  test("carries only that card: the app's type alone, and the card as the image", () => {
    const calls: unknown[][] = [];
    const card = { getBoundingClientRect: () => ({ left: 100, top: 40 }) };
    const dataTransfer = {
      effectAllowed: "all",
      clearData: (...a: unknown[]) => calls.push(["clearData", ...a]),
      setData: (...a: unknown[]) => calls.push(["setData", ...a]),
      setDragImage: (...a: unknown[]) => calls.push(["setDragImage", ...a]),
    };
    const event = { dataTransfer, currentTarget: card, clientX: 130, clientY: 55 };
    startBring({ ticket: "ABC-1" })(
      event as unknown as Parameters<ReturnType<typeof startBring>>[0],
    );
    // A selection drag would have put text/plain there first; it is cleared before the item.
    expect(calls).toEqual([
      ["clearData"],
      ["setData", BRING_MIME, '{"ticket":"ABC-1"}'],
      ["setDragImage", card, 30, 15],
    ]);
    expect(dataTransfer.effectAllowed).toBe("copy");
  });
});

describe("what a row brings", () => {
  test("content alone by default, with the switch; each row copies its context", async () => {
    const html = await render(["ABC-1"]);
    expect(html).toContain('aria-label="Qué lleva una fila a un agente"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Solo contenido/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Con tarea/);
    expect(html).toContain("sin ninguna orden");
    expect(html).toContain('aria-label="Copiar contexto de ABC-1"');
  });
});
