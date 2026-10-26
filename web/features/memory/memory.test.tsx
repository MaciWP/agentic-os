import { describe, expect, test } from "bun:test";
import { failQuery, renderWith } from "../../test-render.tsx";
import { ticket } from "../home/test-fixtures.ts";
import { NotesDesk } from "./desk.tsx";
import { type Doc, HARNESS_SOURCES, snippetParts } from "./queries.ts";

const doc = (over: Partial<Doc>): Doc => ({
  id: "notes:a.md",
  source: "notes",
  rel: "a.md",
  title: "A",
  description: null,
  mtime: Date.now(),
  writable: true,
  body: "# A\n<script>x</script>\n",
  ...over,
});

describe("snippets", () => {
  test("server marks become highlighted runs; stray marks are dropped", () => {
    expect(snippetParts("a \u0002migración\u0003 b")).toEqual([
      { text: "a ", mark: false },
      { text: "migración", mark: true },
      { text: " b", mark: false },
    ]);
    expect(snippetParts("x\u0003y\u0002z")).toEqual([
      { text: "xy", mark: false },
      { text: "z", mark: false },
    ]);
  });
});

describe("Notas desk", () => {
  const T0 = new Date("2026-10-05T09:00:00").getTime();
  const notes = [
    doc({ id: "notes:ABC-1.md", rel: "ABC-1.md", title: "ABC-1 · Export", mtime: T0 + 3 }),
    doc({ id: "notes:suelta.md", rel: "suelta.md", title: "Idea suelta", mtime: T0 + 2 }),
    doc({ id: "notes:NOTA-0.md", rel: "NOTA-0.md", title: "NOTA-0 plantilla", mtime: T0 + 1 }),
  ];
  const harnessDoc = doc({
    id: "claude-memory:m.md",
    source: "claude-memory",
    rel: "m.md",
    title: "Memoria",
    mtime: T0,
    writable: false,
  });
  const seed = (tickets: unknown, extra: [unknown[], unknown][] = []): [unknown[], unknown][] => [
    [["memory", "docs", "notes"], { docs: notes }],
    [["memory", "docs", "memory"], { docs: [] }],
    [["memory", "docs", "prompts"], { docs: [] }],
    ...HARNESS_SOURCES.map((s): [unknown[], unknown] => [
      ["memory", "docs", s],
      { docs: s === "claude-memory" ? [harnessDoc] : [] },
    ]),
    [
      ["memory", "sources"],
      {
        sources: [
          {
            id: "claude-memory",
            label: "Claude Code · memoria",
            writable: false,
            count: 1,
            missing: false,
          },
        ],
      },
    ],
    [["tickets"], tickets],
    [["tickets", "team"], { jql: "j", tickets: [], me: null }],
    ...extra,
  ];
  const mine = { jql: "j", tickets: [{ ...ticket("ABC-1", "indeterminate"), summary: "Export" }] };
  const sections = (html: string) =>
    [...html.matchAll(/<section aria-label="([^"]+)"><h2/g)].map((m) => m[1]);

  test("by ticket by default: only the user's projects count, and loose notes go last", async () => {
    const html = await renderWith(<NotesDesk search={{}} />, seed(mine));
    expect(sections(html)).toEqual(["ABC-1", "Sin ticket"]);
    expect(html).toContain(">Notas y memoria</h1>");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Por ticket</);
  });

  test("by day on demand, and without Jira the list says why it goes by day", async () => {
    const byDay = await renderWith(<NotesDesk search={{ v: "dia" }} />, seed(mine));
    expect(sections(byDay)).toEqual(["2026-10-05"]);
    const off = await renderWith(<NotesDesk search={{}} />, seed({ disabled: true }));
    expect(off).toContain("Jira no está configurado.");
    expect(off).toContain("van por día");
    expect(off).toMatch(/aria-pressed="true"[^>]*>Por día</);
    expect(sections(off)).toEqual(["2026-10-05"]);
  });

  test("a ticket is called not the user's only once the team's tickets were read", async () => {
    const other = doc({ id: "notes:ABC-2.md", rel: "ABC-2.md", title: "ABC-2 · Login" });
    const withOther = (seeded: [unknown[], unknown][]) =>
      seeded.map(([key, value]): [unknown[], unknown] =>
        key.join() === "memory,docs,notes" ? [key, { docs: [...notes, other] }] : [key, value],
      );
    const read = await renderWith(<NotesDesk search={{}} />, withOther(seed(mine)));
    expect(read).toContain("ABC-2 · no está entre tus tickets");
    const failed = await renderWith(
      <NotesDesk search={{}} />,
      withOther(seed(mine)).filter(([key]) => key.join() !== "tickets,team"),
      failQuery(["tickets", "team"], undefined, "jira 502"),
    );
    expect(failed).not.toContain("no está entre tus tickets");
    expect(failed).toContain("ABC-2 · sin datos del equipo");
  });

  test("with Jira unread, the configured project still sends a ticket's line to its note", async () => {
    const atlassian = {
      provider: "atlassian",
      status: "error",
      account: null,
      detail: null,
      project: "ABC",
    };
    const html = await renderWith(
      <NotesDesk search={{}} />,
      seed(undefined, [[["connections"], { connections: [atlassian] }]]).filter(
        ([key]) => key.join() !== "tickets",
      ),
      failQuery(["tickets"], undefined, "jira 502"),
    );
    expect(html).toContain("con ABC-123 va a la nota del ticket");
  });

  test("a failed refetch keeps the desk and the open note, with a warning above", async () => {
    const open = { ...notes[0], body: "# ABC-1 · Export\n\n- 09:00 hecho\n" } as Doc;
    const kept = await renderWith(
      <NotesDesk search={{ id: open.id }} />,
      seed(mine, [
        [["memory", "doc", open.id], { doc: open }],
        [["memory", "search", "ABC-1"], { hits: [] }],
      ]),
      failQuery(["memory", "docs", "notes"], { docs: notes }, "disk gone"),
    );
    expect(kept).toContain(
      "No se ha podido actualizar; lo que ves puede estar desfasado: disk gone",
    );
    expect(kept).toContain(">Editar<");
    expect(kept).toContain("Export");
    // Never read at all: nothing to keep, so the error takes the page.
    const blank = await renderWith(
      <NotesDesk search={{}} />,
      seed(mine).filter(([key]) => key.join() !== "memory,docs,notes"),
      failQuery(["memory", "docs", "notes"]),
    );
    expect(blank).toContain("No se han podido cargar los datos");
    expect(blank).not.toContain("Lista de notas");
  });

  test("a harness note reads as Markdown, read-only, its raw HTML never rendered", async () => {
    const html = await renderWith(
      <NotesDesk search={{ id: harnessDoc.id }} />,
      seed(mine, [
        [["memory", "doc", harnessDoc.id], { doc: harnessDoc }],
        [["memory", "search", "Memoria"], { hits: [] }],
      ]),
    );
    expect(html).toContain("Solo lectura");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(">Editar<");
  });

  test("a note of the user's opens to read, with its ticket and an edit button", async () => {
    const open = { ...notes[0], body: "# ABC-1 · Export\n\n- 09:00 hecho\n" } as Doc;
    const html = await renderWith(
      <NotesDesk search={{ id: open.id }} />,
      seed(mine, [
        [["memory", "doc", open.id], { doc: open }],
        [["memory", "search", "ABC-1"], { hits: [] }],
      ]),
    );
    expect(html).toContain(">Editar<");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Del mismo ticket");
    expect(html).toContain("Export");
  });
});
