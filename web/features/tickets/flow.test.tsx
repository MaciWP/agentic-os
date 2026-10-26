import { describe, expect, test } from "bun:test";
import type { Ticket } from "../../../server/features/jira/issues.ts";
import { renderWith } from "../../test-render.tsx";
import { pr, ticket } from "../home/test-fixtures.ts";
import { type Kickoff, KickoffButton, kickoffText } from "../kickoff/kickoff.tsx";
import { projects } from "../projects/test-fixtures.ts";
import {
  Board,
  type BoardFacts,
  BoardSwitch,
  boardColumns,
  type Column,
  shownBy,
  WhoFilter,
} from "./board.tsx";
import type { TicketRow } from "./groups.ts";
import { TicketsPage } from "./page.tsx";
import { type ReviewStep, runSteps, type StepState } from "./queries.ts";
import { Review } from "./review.tsx";

const ana = { accountId: "u-ana", displayName: "Ana Ruiz" };
const bea = { accountId: "u-bea", displayName: "Bea Soto" };
const me = { accountId: "u-me", displayName: "Yo Mismo" };

// Status ids, so board columns match the way Jira's do.
const STATUS_IDS: Record<string, string> = {
  "Tareas por hacer": "20003",
  QUÉ: "20002",
  "En curso": "3",
  "Pull Request": "20004",
  "In Product Review": "20005",
};
const row = (key: string, status: string, over: Partial<TicketRow> = {}): TicketRow => ({
  ...ticket(key, "indeterminate"),
  status: { id: STATUS_IDS[status] ?? "0", name: status, category: "indeterminate" },
  summary: `Resumen de ${key}`,
  ...over,
});
const full = (r: TicketRow): Ticket => ({
  ...r,
  descriptionAdf: null,
  descriptionMd: "",
  acceptanceCriteria: [],
});

const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
  isMine: (t) => t.assignee?.accountId === me.accountId,
  prsOf: () => [],
  envOf: () => null,
  ...over,
});

// The cards: each list item with its ticket's link.
const cards = (html: string) =>
  html
    .split("<li")
    .slice(1)
    .filter((s) => s.includes("data-ticket="));
const card = (html: string, key: string) =>
  cards(html).find((c) => c.includes(`data-ticket="${key}"`)) ?? "";

describe("whose tickets", () => {
  test("all, nobody's, or one person's", () => {
    const a = row("ABC-1", "QUÉ", { assignee: ana });
    const none = row("ABC-2", "QUÉ");
    expect([a, none].filter((t) => shownBy("all", t)).map((t) => t.key)).toEqual([
      "ABC-1",
      "ABC-2",
    ]);
    expect([a, none].filter((t) => shownBy("none", t)).map((t) => t.key)).toEqual(["ABC-2"]);
    expect([a, none].filter((t) => shownBy("u-ana", t)).map((t) => t.key)).toEqual(["ABC-1"]);
  });
});

describe("Revisar yo steps", () => {
  const step = (id: string, send: () => Promise<unknown>): ReviewStep => ({ id, label: id, send });

  test("a failed Jira write neither stops the PRs nor is undone; each step reports alone", async () => {
    const calls: string[] = [];
    const seen: [string, StepState][] = [];
    await runSteps(
      [
        step("jira", async () => {
          calls.push("jira");
          throw new Error("Jira 503");
        }),
        step("api#4", async () => {
          calls.push("api#4");
        }),
        step("web#9", async () => {
          calls.push("web#9");
          throw new Error("GitHub 422");
        }),
      ],
      (id, s) => seen.push([id, s]),
    );
    expect(calls).toEqual(["jira", "api#4", "web#9"]);
    const last = Object.fromEntries(seen);
    expect(last.jira).toEqual({ state: "failed", error: "Jira 503" });
    expect(last["api#4"]).toEqual({ state: "ok" });
    expect(last["web#9"]).toEqual({ state: "failed", error: "GitHub 422" });
  });

  test("Jira goes first, before any PR is asked", async () => {
    const calls: string[] = [];
    let release = () => {};
    const jira = new Promise<void>((r) => {
      release = r;
    });
    const done = runSteps(
      [
        step("api#4", async () => calls.push("api#4")),
        step("jira", async () => {
          calls.push("jira");
          await jira;
        }),
      ],
      () => {},
    );
    await Bun.sleep(1);
    expect(calls).toEqual(["jira"]);
    release();
    await done;
    expect(calls).toEqual(["jira", "api#4"]);
  });
});

describe("Flujo board", () => {
  const board = (
    tickets: TicketRow[],
    f = facts(),
    picked?: string,
    columns: Column[] | null = null,
  ) =>
    renderWith(
      <Board
        tickets={tickets}
        columns={columns}
        picked={picked}
        search={{ w: "all", b: "sprint" }}
        facts={f}
      />,
    );
  const titles = (html: string) =>
    [...html.matchAll(/<section aria-label="([^"]+)"/g)].map((m) => m[1]);

  test("a board's columns in its order, empty ones too; a card of a shared column names its status", async () => {
    const columns = [
      { name: "TO DO", statuses: ["20003", "20002"] },
      { name: "PULL REQUEST", statuses: ["20004"] },
      { name: "PRODUCT REVIEW", statuses: ["20005"] },
    ];
    const tickets = [
      row("ABC-2", "Pull Request"),
      row("ABC-1", "QUÉ"),
      row("ABC-3", "Tareas por hacer"),
      row("ABC-9", "Rechazado"),
    ];
    expect(
      boardColumns(columns, tickets).map((c) => [c.name, c.tickets.map((t) => t.key)]),
    ).toEqual([
      ["TO DO", ["ABC-1", "ABC-3"]],
      ["PULL REQUEST", ["ABC-2"]],
      ["PRODUCT REVIEW", []],
    ]);
    const html = await board(tickets, facts(), undefined, columns);
    expect(titles(html)).toEqual(["TO DO", "PULL REQUEST", "PRODUCT REVIEW"]);
    expect(card(html, "ABC-1")).toContain(">QUÉ<");
    expect(card(html, "ABC-2")).not.toContain(">Pull Request<");
    expect(card(html, "ABC-9")).toBe("");
  });

  test("the board switch keeps whose tickets, and shows nothing for a single board", async () => {
    const two = [
      { id: "sprint", name: "Sprint" },
      { id: "refinamiento", name: "Refinamiento" },
    ];
    const html = await renderWith(
      <BoardSwitch boards={two} shown="sprint" who="all" ticketKey={undefined} />,
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Sprint/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*?Refinamiento/);
    const one = await renderWith(
      <BoardSwitch
        boards={[two[0] ?? { id: "", name: "" }]}
        shown="sprint"
        who={undefined}
        ticketKey={undefined}
      />,
    );
    expect(one).not.toContain('aria-label="Tablero"');
  });

  test("without board columns, one column per status in the workflow's order; a teammate's card names its owner", async () => {
    const html = await board([
      row("ABC-3", "Release Ready", { assignee: ana }),
      row("ABC-1", "QUÉ", { assignee: me }),
      row("ABC-2", "En curso"),
    ]);
    expect(titles(html)).toEqual(["QUÉ", "En curso", "Release Ready"]);
    expect(card(html, "ABC-3")).toContain("Ana Ruiz");
    expect(card(html, "ABC-1")).not.toContain("Yo Mismo");
    expect(card(html, "ABC-2")).toContain("Sin asignar");
    expect(card(html, "ABC-3")).toContain('href="/tickets/ABC-3?w=all&amp;b=sprint"');
  });

  test("a ready PR with nobody reviewing warns; a draft, an env or the date say what they are", async () => {
    const prs = {
      "ABC-1": [{ ...pr(4, "open"), title: "ABC-1 export" }],
      "ABC-2": [{ ...pr(7, "open"), title: "ABC-2 wip", draft: true }],
      "ABC-3": [{ ...pr(8, "open"), title: "ABC-3 done" }],
    } as Record<string, ReturnType<typeof pr>[]>;
    const html = await board(
      [
        row("ABC-1", "QUÉ"),
        row("ABC-2", "QUÉ"),
        row("ABC-3", "QUÉ", { reviewers: [bea] }),
        row("ABC-4", "QUÉ"),
      ],
      facts({ prsOf: (k) => prs[k] ?? [], envOf: (k) => (k === "ABC-4" ? "abc-4" : null) }),
      "ABC-2",
    );
    expect(card(html, "ABC-1")).toMatch(/text-warn[^>]*>sin revisor</);
    expect(card(html, "ABC-2")).toContain(">#7 · borrador<");
    expect(card(html, "ABC-2")).toContain('aria-current="page"');
    expect(card(html, "ABC-3")).toContain(">#8<");
    expect(card(html, "ABC-4")).toContain(">abc-4<");
  });

  test("the filter lists the people by name; without the board only «Míos» is left", async () => {
    const team = [
      row("ABC-1", "QUÉ", { assignee: bea }),
      row("ABC-2", "QUÉ", { assignee: ana }),
      row("ABC-3", "QUÉ", { assignee: ana }),
      row("ABC-4", "QUÉ", { assignee: me }),
      row("ABC-5", "QUÉ"),
    ];
    const ok = await renderWith(
      <WhoFilter
        who="u-ana"
        board={undefined}
        mine={1}
        team={{ state: "ok", tickets: team, isMine: facts().isMine }}
        ticketKey={undefined}
      />,
    );
    const chips = [...ok.matchAll(/aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map(
      (m) =>
        `${m[1] === "true" ? "*" : ""}${m[2]
          ?.replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()}`,
    );
    expect(chips).toEqual(["Míos 1", "Todo el equipo 5", "*AR Ana 2", "BS Bea 1", "Sin asignar 1"]);

    // Without the board (off or failed) only «Míos» is left; the page says why below.
    const off = await renderWith(
      <WhoFilter
        who={undefined}
        board={undefined}
        mine={null}
        team={{ state: "off" }}
        ticketKey={undefined}
      />,
    );
    expect(off).toContain(">Míos<");
    expect(off).not.toContain("Todo el equipo");
  });
});

describe("Revisión", () => {
  test("a teammate's ticket offers «Revisar yo» and names who reviews it already", async () => {
    const t = full(row("ABC-1", "In Product Review", { assignee: ana, reviewers: [bea] }));
    const html = await renderWith(
      <Review t={t} me={me.accountId} prs={[{ ...pr(4, "open"), title: "ABC-1" }]} prGap={null} />,
    );
    expect(html).toContain("Ana Ruiz");
    expect(html).toContain(">Bea Soto<");
    expect(html).toContain(">Revisar yo<");
    expect(html).toContain("acme/api#4 ↗");
  });

  test("already a reviewer in Jira, asked on one PR and author of the other: nothing to take", async () => {
    const t = full(row("ABC-1", "In Product Review", { assignee: ana, reviewers: [me, bea] }));
    const html = await renderWith(
      <Review
        t={t}
        me={me.accountId}
        prs={[
          { ...pr(4, "review"), title: "ABC-1" },
          { ...pr(5, "mine"), title: "ABC-1 tests" },
        ]}
        prGap={null}
      />,
    );
    expect(html).toContain(">Tú, Bea Soto<");
    expect(html).toContain("ya te la han pedido");
    expect(html).toContain("es tuyo");
    expect(html).not.toContain(">Revisar yo<");
    expect(html).toContain("Ya revisas este ticket");
  });

  test("nobody reviewing is a warning, not an empty cell", async () => {
    const t = full(row("ABC-1", "QUÉ", { assignee: ana }));
    const html = await renderWith(<Review t={t} me={null} prs={[]} prGap={null} />);
    expect(html).toMatch(/text-warn[^>]*>Nadie todavía</);
    expect(html).toContain("Ningún PR abierto nombra el ticket");
  });

  test("PRs still loading: «Revisar yo» waits, so it never sends Jira alone by mistake", async () => {
    const t = full(row("ABC-1", "QUÉ", { assignee: ana }));
    const html = await renderWith(<Review t={t} me={me.accountId} prs={[]} prGap="loading" />);
    expect(html).toContain("Cargando PRs…");
    expect(html).not.toContain("Ningún PR abierto");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Revisar yo</);
  });

  test("an unread GitHub is said in the PR row, never shown as a ticket without PRs", async () => {
    const t = full(row("ABC-1", "QUÉ", { assignee: ana }));
    const html = await renderWith(
      <Review t={t} me={me.accountId} prs={[]} prGap="GitHub 502 on acme/api" />,
    );
    expect(html).toMatch(/text-warn[^>]*>No se leyeron todos los PRs: GitHub 502 on acme\/api</);
    expect(html).not.toContain("Ningún PR abierto");
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Revisar yo</);

    const off = await renderWith(<Review t={t} me={me.accountId} prs={[]} prGap="off" />);
    expect(off).toContain("GitHub no está configurado");
    expect(off).not.toContain("No se leyeron");
  });
});

describe("Tickets page", () => {
  const mine = [row("ABC-1", "QUÉ", { assignee: me }), row("ABC-7", "BORRADOR", { assignee: me })];
  const onBoard = [mine[0] as TicketRow, row("ABC-2", "En curso", { assignee: ana })];
  const sprint = {
    board: {
      id: "sprint",
      name: "Sprint",
      columns: [
        { name: "TO DO", statuses: ["20002"] },
        { name: "IN PROGRESS", statuses: ["3"] },
      ],
    },
    boards: [
      { id: "sprint", name: "Sprint" },
      { id: "refinamiento", name: "Refinamiento" },
    ],
    jql: "j",
    tickets: onBoard,
    me: me.accountId,
  };
  const page = (extra: [unknown[], unknown][] = []) =>
    renderWith(<TicketsPage />, [
      [["tickets"], { jql: "j", tickets: mine }],
      [["tickets", "board", ""], sprint],
      [["projects"], projects()],
      ...extra,
    ]);

  test("shows the first board, only the user's own tickets on it, with the team one click away", async () => {
    const html = await page([[["prs"], { prs: [], errors: [], repos: [] }]]);
    expect(html).toContain(">Tickets</h1>");
    expect(html).toContain("tablero «Sprint» de Jira");
    // ABC-7 is the user's too, but not on this board.
    expect(cards(html).map((c) => /data-ticket="([^"]+)"/.exec(c)?.[1])).toEqual(["ABC-1"]);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Míos.*?1/);
    expect(html).toMatch(/Todo el equipo.*?2/);
    expect(html).toContain('aria-label="Tablero"');
    expect(html).not.toContain('role="alert"');
  });

  test("a GitHub failure is said on the page, never shown as tickets without PRs", async () => {
    const html = await page([
      [
        ["prs"],
        { prs: [], errors: ["gh's active account is x; run gh auth switch --user me"], repos: [] },
      ],
    ]);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Sin PRs de GitHub en las tarjetas: gh&#x27;s active account is x");
  });
});

describe("Kickoff", () => {
  const kickoff = (over: Partial<Kickoff> = {}): Kickoff => ({
    key: "ABC-1",
    mode: "start",
    step: "env",
    state: "running",
    error: null,
    warning: null,
    job: null,
    terminal: null,
    reused: false,
    sent: false,
    startedAt: "2026-10-07T10:00:00Z",
    endedAt: null,
    ...over,
  });

  test("a card says a kickoff runs or failed, before its PR or env", async () => {
    const runs: Record<string, Kickoff> = {
      "ABC-1": kickoff(),
      "ABC-2": kickoff({ key: "ABC-2", state: "failed", step: "services", error: "boom" }),
      "ABC-3": kickoff({ key: "ABC-3", state: "ok", terminal: "t1" }),
    };
    const html = await renderWith(
      <Board
        tickets={[row("ABC-1", "QUÉ"), row("ABC-2", "QUÉ"), row("ABC-3", "QUÉ")]}
        columns={null}
        picked={undefined}
        search={{ w: "all" }}
        facts={facts({ envOf: () => "env-x", kickoffOf: (k) => runs[k] })}
      />,
    );
    expect(card(html, "ABC-1")).toContain(">arrancando…<");
    expect(card(html, "ABC-2")).toMatch(/text-warn[^>]*>arranque falló</);
    expect(card(html, "ABC-2")).toContain("Falló levantando los servicios: boom");
    // A kickoff that went well leaves the card as it was.
    expect(card(html, "ABC-3")).toContain(">env-x<");
  });

  test("«Empezar» shows the failed step with its reason, and offers to try again", async () => {
    const html = await renderWith(<KickoffButton ticketKey="ABC-1" mode="start" />, [
      [["kickoff"], { kickoffs: [kickoff({ state: "failed", error: "create falló" })] }],
      [["envjobs"], { jobs: [] }],
    ]);
    expect(html).toMatch(/<button[^>]*>Empezar<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Empezar/);
    expect(html).toMatch(/role="alert"[^>]*>Falló preparando el entorno: create falló/);
  });

  test("while it runs the button waits, and the step links to Claude once it is there", async () => {
    const html = await renderWith(<KickoffButton ticketKey="ABC-1" mode="start" />, [
      [["kickoff"], { kickoffs: [kickoff({ step: "jira", terminal: "t1" })] }],
      [["envjobs"], { jobs: [] }],
    ]);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Empezar<\/button>/);
    expect(html).toContain("moviendo el ticket en Jira…");
    expect(html).toContain("Abrir en la Mesa");
  });

  test("a review clicked again says whether the open Claude got something new", () => {
    const done = { state: "ok" as const, mode: "review" as const, reused: true, terminal: "t1" };
    expect(kickoffText(kickoff({ ...done, sent: true }))).toBe(
      "Le he pasado a Claude lo nuevo de las PRs.",
    );
    expect(kickoffText(kickoff(done))).toBe("Nada nuevo en las PRs desde la última ronda.");
    expect(kickoffText(kickoff({ ...done, mode: "start" }))).toBe(
      "Claude ya trabajaba en este ticket.",
    );
  });

  test("«Revisar a fondo» offers each PR checked when there are several", async () => {
    const html = await renderWith(
      <KickoffButton ticketKey="ABC-1" mode="review" pulls={[pr(4, "open"), pr(5, "review")]} />,
      [
        [["kickoff"], { kickoffs: [] }],
        [["envjobs"], { jobs: [] }],
      ],
    );
    expect(html).toContain("PRs que revisa");
    expect(html.match(/type="checkbox"[^>]*checked/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*>Revisar a fondo<\/button>/);
  });
});
