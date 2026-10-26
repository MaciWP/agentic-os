import { describe, expect, test } from "bun:test";
import type { Proposal, ProposalItem } from "../../../shared/mail-sort.ts";
import { renderWith } from "../../test-render.tsx";
import { ProposalView, proposalGroups, resultLine, SortActions } from "./mail-sort.tsx";

const item = (id: string, over: Partial<ProposalItem> = {}): ProposalItem => ({
  id,
  op: "move",
  folder: "Facturas",
  newFolder: false,
  outside: false,
  reason: "Siempre archivas sus facturas aquí",
  from: "Ana",
  subject: `Asunto ${id}`,
  result: null,
  ...over,
});

const proposal: Proposal = {
  id: 7,
  account: "personal",
  createdAt: "2026-10-16T08:00:00.000Z",
  status: "pending",
  items: [
    item("t1", { op: "trash", folder: null, reason: "Spam: nunca lo abres" }),
    item("t2", { folder: "Viajes" }),
    item("t3"),
  ],
};

describe("a proposal's groups", () => {
  test("one per folder by name, the account's trash last", () => {
    expect(
      proposalGroups("personal", proposal.items).map((g) => [g.title, g.items.length]),
    ).toEqual([
      ["Facturas", 1],
      ["Viajes", 1],
      ["Papelera", 1],
    ]);
    expect(proposalGroups("work", [item("a", { op: "trash", folder: null })])[0]?.title).toBe(
      "Elementos eliminados",
    );
  });

  test("a new folder says so, and the archive goes before the trash", () => {
    const groups = proposalGroups("personal", [
      item("a", { op: "trash", folder: null }),
      item("b", { op: "archive", folder: null }),
      item("c", { folder: "Viajes", newFolder: true }),
      item("d"),
    ]);
    expect(groups.map((g) => [g.title, g.isNew])).toEqual([
      ["Facturas", false],
      ["Viajes", true],
      ["Archivar (sin etiqueta)", false],
      ["Papelera", false],
    ]);
  });

  test("the result line counts each outcome once, in a fixed order", () => {
    const items = [
      item("a", { result: "ok" }),
      item("b", { result: "ok" }),
      item("c", { result: "gone" }),
      item("d", { result: "skipped" }),
    ];
    expect(resultLine(items)).toBe("2 ordenados · 1 sin marcar · 1 ya no estaba en la bandeja");
  });
});

const access = (desktop: boolean): [unknown[], unknown] => [
  ["access"],
  { remote: !desktop, desktop },
];

describe("the review", () => {
  test("every mail starts ticked under its folder, with the agent's reason", async () => {
    const html = await renderWith(<ProposalView account="personal" onClose={() => {}} />, [
      [["mail", "proposal", "personal"], { proposal }],
      access(true),
    ]);
    expect(html).toContain("Ordenar Personal");
    expect(html).toContain("→ Papelera");
    expect(html).toContain("Spam: nunca lo abres");
    expect(html).toContain("Aplicar 3");
    expect(html).toContain("Saldrá un diálogo en el Mac");
    expect(html.match(/checked=""/g)?.length).toBe(6);
  });

  test("from another device it cannot apply: the dialog is on the Mac", async () => {
    const html = await renderWith(<ProposalView account="personal" onClose={() => {}} />, [
      [["mail", "proposal", "personal"], { proposal }],
      access(false),
    ]);
    expect(html).toContain("Se aplica desde el Mac");
  });

  test("nothing pending says how to get a proposal", async () => {
    const html = await renderWith(<ProposalView account="work" onClose={() => {}} />, [
      [["mail", "proposal", "work"], { proposal: null }],
    ]);
    expect(html).toContain("No hay ninguna propuesta pendiente");
  });

  test("the column offers the agent, and the review once a proposal waits", async () => {
    const none = await renderWith(<SortActions account="work" onReview={() => {}} />, [
      [["mail", "proposal", "work"], { proposal: null }],
    ]);
    expect(none).toContain("Categorizar");
    expect(none).not.toContain("Revisar propuesta");
    const waiting = await renderWith(<SortActions account="personal" onReview={() => {}} />, [
      [["mail", "proposal", "personal"], { proposal }],
    ]);
    expect(waiting).toContain("Revisar propuesta · 3");
  });
});
