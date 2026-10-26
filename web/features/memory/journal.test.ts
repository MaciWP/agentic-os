import { describe, expect, test } from "bun:test";
import {
  appendLine,
  captureTarget,
  dayLabel,
  entryLine,
  groupByDay,
  groupByTicket,
  NONE,
  withoutTitle,
} from "./journal.ts";
import { projectsOf, ticketsIn } from "./keys.ts";
import type { DocSummary } from "./queries.ts";

const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-10-06T10:00:00");
const doc = (id: string, title: string, iso: string): DocSummary => ({
  id: `notes:${id}.md`,
  source: "notes",
  rel: `${id}.md`,
  title,
  description: null,
  mtime: at(iso),
});
const projects = projectsOf([{ key: "ABC-1" }, { key: "WEB-9" }]);

describe("ticket keys", () => {
  test("only the user's Jira projects count, and with none known no key is guessed", () => {
    const d = doc("x", "ABC-12 y NOTA-0 y web-9", "2026-10-06T09:00:00");
    expect(ticketsIn(d, projects)).toEqual(["ABC-12", "WEB-9"]);
    expect(ticketsIn(d, new Set())).toEqual([]);
  });
});

describe("days", () => {
  test("today, yesterday, a weekday, then the date", () => {
    expect(dayLabel("2026-10-06", NOW)).toBe("Hoy");
    expect(dayLabel("2026-10-05", NOW)).toBe("Ayer");
    expect(dayLabel("2026-10-02", NOW)).toBe("viernes");
    expect(dayLabel("2026-09-01", NOW)).toBe("martes, 1 de septiembre");
  });
});

describe("groups", () => {
  const docs = [
    doc("a", "ABC-1 plan", "2026-10-06T09:00:00"),
    doc("b", "suelta", "2026-10-06T08:00:00"),
    doc("c", "WEB-9 y ABC-1", "2026-10-05T18:00:00"),
  ];
  const keysOf = (d: DocSummary) => ticketsIn(d, projects);

  test("by day, newest day first, keeping the order inside", () => {
    expect(groupByDay(docs).map((g) => [g.id, g.docs.map((d) => d.rel)])).toEqual([
      ["2026-10-06", ["a.md", "b.md"]],
      ["2026-10-05", ["c.md"]],
    ]);
  });

  test("by ticket: a note under each key it names, the last touched first, «Sin ticket» last", () => {
    expect(groupByTicket(docs, keysOf).map((g) => [g.id, g.docs.map((d) => d.rel)])).toEqual([
      ["ABC-1", ["a.md", "c.md"]],
      ["WEB-9", ["c.md"]],
      [NONE, ["b.md"]],
    ]);
  });
});

describe("quick note", () => {
  test("a line naming a ticket goes to that ticket's note, titled with its summary", () => {
    const summary = (k: string) => (k === "ABC-412" ? "Exportar CSV" : undefined);
    expect(captureTarget("revisar abc-412 mañana", projects, summary, NOW)).toEqual({
      name: "ABC-412",
      title: "ABC-412 · Exportar CSV",
      key: "ABC-412",
    });
    expect(captureTarget("WEB-3 sin resumen", projects, summary, NOW).title).toBe("WEB-3");
  });

  test("a line without a known ticket goes to today's journal", () => {
    expect(captureTarget("llamar a NOTA-0", projects, () => undefined, NOW)).toEqual({
      name: "Diario 2026-10-06",
      title: "Diario 2026-10-06",
      key: null,
    });
  });

  test("the line is appended on its own line, timed and flattened", () => {
    const line = entryLine(NOW, "  uno\n dos ");
    expect(line).toBe("- 10:00 uno dos");
    expect(appendLine("# Diario\n\n- 09:00 a\n", line)).toBe(
      "# Diario\n\n- 09:00 a\n- 10:00 uno dos\n",
    );
    expect(appendLine("# Diario", line)).toBe("# Diario\n- 10:00 uno dos\n");
    expect(appendLine("", line)).toBe("- 10:00 uno dos\n");
  });
});

describe("reader", () => {
  test("the heading that repeats the page title is dropped, any other is kept", () => {
    expect(withoutTitle("# Plan\n\nTexto\n", "Plan")).toBe("Texto\n");
    expect(withoutTitle("# Plan", "Plan")).toBe("");
    expect(withoutTitle("# Otro\n\nTexto", "Plan")).toBe("# Otro\n\nTexto");
    expect(withoutTitle("Texto\n# Plan", "Plan")).toBe("Texto\n# Plan");
  });
});
