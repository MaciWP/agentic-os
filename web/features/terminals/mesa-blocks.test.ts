import { describe, expect, test } from "bun:test";
import {
  addBlock,
  assignMesa,
  byBlock,
  dropBlock,
  groupByState,
  mergeProposal,
  type RepoGroups,
  seedBlocks,
  suggestBlock,
} from "./mesa-blocks.ts";
import type { Workspace } from "./mesas.ts";
import { terminal } from "./test-fixtures.ts";

const repos: RepoGroups = {
  repos: [
    { id: "backend", group: "Acme" },
    { id: "frontend", group: "Acme" },
    { id: "agentic-os" },
    { id: "poneglyph" },
    { id: "cv-astro" },
  ],
  envs: { repos: ["backend", "frontend"] },
};
// Shaped like the Mesas on 2026-10-13: one or two terminals each, no blocks.
const terminals = [
  terminal({ id: "t-back", location: "repo:backend" }),
  terminal({ id: "t-env", harness: "env", location: "env:abc-1160", env: "abc-1160" }),
  terminal({ id: "t-cv", location: "repo:cv-astro" }),
  terminal({ id: "t-a1", location: "repo:agentic-os" }),
  terminal({ id: "t-a2", location: "repo:agentic-os" }),
  terminal({ id: "t-pg", location: "repo:poneglyph" }),
  terminal({ id: "t-home", location: "home" }),
];
const mesa = (id: string, ids: string[], block?: string) => ({
  id,
  name: `Mesa ${id}`,
  ids,
  layout: null,
  ...(block && { block }),
});
const ws = (mesas: Workspace["mesas"], blocks: Workspace["blocks"] = []): Workspace => ({
  version: 1,
  activeId: mesas[0]?.id ?? "",
  mesas,
  blocks,
});
const today = ws([
  mesa("1", ["t-back"]),
  mesa("2", ["t-env"]),
  mesa("3", ["t-cv"]),
  mesa("4", ["t-a1"]),
  mesa("5", ["t-a2"]),
  mesa("6", ["t-pg"]),
  mesa("7", ["t-home"]),
]);

describe("block changes", () => {
  const w = { id: "w", name: "W", color: "blue" as const };
  test("add with Mesas, assign out, drop keeps the Mesas", () => {
    let s = addBlock(today, w, ["1", "2"]);
    expect(s.mesas.filter((m) => m.block === "w").map((m) => m.id)).toEqual(["1", "2"]);
    s = assignMesa(s, "2", null);
    expect(s.mesas[1]).not.toHaveProperty("block");
    s = addBlock(s, { id: "p", name: "P", color: "rose" });
    const dropped = dropBlock(s, "w");
    expect(dropped.blocks?.map((b) => b.id)).toEqual(["p"]);
    expect(dropped.mesas).toHaveLength(today.mesas.length);
    expect(dropped.mesas.some((m) => m.block === "w")).toBe(false);
  });
});

describe("suggestBlock", () => {
  test("the one block already working on the Mesa's project", () => {
    const s = ws(
      [mesa("1", ["t-back"], "w"), mesa("4", ["t-a1"], "a"), mesa("2", ["t-env"])],
      [
        { id: "w", name: "Trabajo", color: "blue" },
        { id: "a", name: "Agentic", color: "violet" },
      ],
    );
    const loose = s.mesas[2];
    if (!loose) throw new Error("fixture");
    // The env's repos are Acme's, like the backend's.
    expect(suggestBlock(s, loose, terminals, repos)?.id).toBe("w");
    expect(suggestBlock(s, mesa("7", ["t-home"]), terminals, repos)).toBeNull();
  });
  test("a Mesa made in the wrong block is pointed to the right one, never to its own", () => {
    const blocks = [
      { id: "w", name: "Trabajo", color: "blue" as const },
      { id: "a", name: "Agentic", color: "violet" as const },
    ];
    const wrong = mesa("2", ["t-env"], "a");
    const s = ws([mesa("1", ["t-back"], "w"), mesa("4", ["t-a1"], "a"), wrong], blocks);
    expect(suggestBlock(s, wrong, terminals, repos)?.id).toBe("w");
    const right = mesa("2", ["t-env"], "w");
    const t = ws([mesa("1", ["t-back"], "w"), right], blocks);
    expect(suggestBlock(t, right, terminals, repos)).toBeNull();
    // Alone in its block, a Mesa does not suggest that block for itself.
    const alone = mesa("1", ["t-back"]);
    expect(suggestBlock(ws([alone], blocks), alone, terminals, repos)).toBeNull();
  });
});

describe("seedBlocks", () => {
  test("one proposal per project, biggest first; a Mesa on no project stays out", () => {
    const proposal = seedBlocks(today, terminals, repos);
    expect(proposal.map((p) => [p.name, p.mesas])).toEqual([
      ["Acme", ["1", "2"]],
      ["agentic-os", ["4", "5"]],
      ["cv-astro", ["3"]],
      ["poneglyph", ["6"]],
    ]);
    expect(new Set(proposal.map((p) => p.color)).size).toBe(4);
  });
  test("merging folds one proposal into another", () => {
    const proposal = mergeProposal(seedBlocks(today, terminals, repos), "poneglyph", "cv-astro");
    expect(proposal.find((p) => p.key === "cv-astro")?.mesas).toEqual(["3", "6"]);
    expect(proposal.some((p) => p.key === "poneglyph")).toBe(false);
  });
  test("Mesas already in a block are not proposed again", () => {
    const s = addBlock(today, { id: "w", name: "Trabajo", color: "blue" }, ["1", "2"]);
    expect(seedBlocks(s, terminals, repos).some((p) => p.key === "Acme")).toBe(false);
  });
});

describe("groupByState", () => {
  test("waits, runs and done in that order; the most pressing wait first, else the list's order", () => {
    const items = [
      { id: "a", rank: 6 },
      { id: "b", rank: 3 },
      { id: "c", rank: 4 },
      { id: "d", rank: 0 },
      { id: "e", rank: 5 },
      { id: "f", rank: 2 },
      { id: "g", rank: 2 },
    ];
    const groups = groupByState(items, (x) => x.rank);
    expect(groups.map((g) => [g.name, g.items.map((x) => x.id).join("")])).toEqual([
      ["Te esperan", "dfgb"],
      ["En marcha", "ce"],
      ["Terminadas", "a"],
    ]);
  });
  test("an empty group is left out", () => {
    expect(groupByState([{ rank: 4 }], (x) => x.rank).map((g) => g.key)).toEqual(["runs"]);
  });
});

describe("byBlock", () => {
  test("a band per block in the blocks' order, «Sin bloque» last, each in the list's order", () => {
    const s = ws(
      [
        mesa("1", [], "b"),
        mesa("2", []),
        mesa("3", [], "a"),
        mesa("4", [], "gone"),
        mesa("5", [], "b"),
      ],
      [
        { id: "a", name: "Personal", color: "rose" },
        { id: "b", name: "Trabajo", color: "green" },
        { id: "empty", name: "Vacío", color: "slate" },
      ],
    );
    const bands = byBlock(
      s.mesas.map((m) => ({ mesa: m })),
      s,
    );
    expect(
      bands.map((b) => [b.key, b.name, b.color, b.items.map((x) => x.mesa.id).join("")]),
    ).toEqual([
      ["a", "Personal", "rose", "3"],
      ["b", "Trabajo", "green", "15"],
      ["", "Sin bloque", null, "24"],
    ]);
  });
});
