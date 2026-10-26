import { describe, expect, test } from "bun:test";
import { projects } from "../projects/test-fixtures.ts";
import { terminal } from "../terminals/test-fixtures.ts";
import { buildItems, matchItems } from "./items.ts";

const items = buildItems({
  terminals: [
    terminal({ id: "t1", harness: "shell", location: "repo:alpha", cwd: "/src/alpha" }),
    terminal({ id: "t2", harness: "claude", ticket: "ABC-101", state: "exited" }),
  ],
  projects: projects(),
  tickets: [{ key: "ABC-101", summary: "Categoría de activos" }],
  prs: [{ repo: "api", number: 7, title: "Fix login", url: "https://example.test/pr/7" }],
});
const labels = (q: string) => matchItems(items, q).map((it) => it.label);

describe("palette items", () => {
  test("every page, terminal, tree node, ticket and PR, in the groups' order", () => {
    expect(items.map((it) => it.key)).toEqual([
      "page:/",
      "page:/terminales",
      "page:/agentes",
      "page:/consumo",
      "page:/tickets",
      "page:/docs",
      "t:t1",
      "t:t2",
      "n:env:env-a",
      "n:env:env-a/p-backend",
      "n:repo:alpha",
      "n:wt:alpha:fix",
      "n:repo:beta",
      "n:app",
      "k:ABC-101",
      "pr:api#7",
    ]);
  });

  test("the open Mesa's commands come last and answer to what they act on", () => {
    const withMesa = buildItems({
      terminals: [],
      commands: [
        { key: "rename", label: "Renombrar la Mesa", hint: "Revisión" },
        { key: "close", label: "Cerrar la Mesa", hint: "Revisión" },
      ],
    });
    expect(withMesa.at(-1)).toMatchObject({
      key: "c:close",
      group: "Mesa abierta",
      action: { go: "command", key: "close" },
    });
    expect(matchItems(withMesa, "renombrar revision").map((it) => it.key)).toEqual(["c:rename"]);
  });

  test("once Agentic OS is a repo, its node shows once", () => {
    const own = buildItems({
      terminals: [],
      projects: { ...projects(), app: { location: "repo:alpha", label: "alpha" } },
    });
    expect(own.filter((it) => it.key === "n:repo:alpha")).toHaveLength(1);
    expect(own.some((it) => it.key === "n:app")).toBe(false);
  });

  test("a terminal says where it runs, its ticket and its state; a node keeps the tree's label", () => {
    const byKey = new Map(items.map((it) => [it.key, it]));
    expect(byKey.get("t:t1")?.hint).toBe("alpha/main · en marcha");
    expect(byKey.get("t:t2")?.hint).toBe("Agentic OS · ABC-101 · terminada");
    expect(byKey.get("n:env:env-a/p-backend")?.label).toBe("env-a/p-backend");
    expect(byKey.get("n:wt:alpha:fix")?.label).toBe("alpha/fix");
  });

  test("every word must match, in any order, without accents or case", () => {
    expect(labels("categoria")).toEqual(["ABC-101 Categoría de activos"]);
    expect(labels("ACTIVOS abc")).toEqual(["ABC-101 Categoría de activos"]);
    expect(labels("abc-101")).toEqual(["Claude", "ABC-101 Categoría de activos"]);
    expect(labels("alpha fix")).toEqual(["alpha/fix"]);
    expect(labels("nada parecido")).toEqual([]);
  });

  test("a named terminal is found by its name and still by its kind", () => {
    const named = buildItems({
      terminals: [terminal({ id: "t4", harness: "shell", name: "Pruebas API", cwd: "/x/beta" })],
    });
    const found = (q: string) => matchItems(named, q).map((it) => it.key);
    expect(named.find((it) => it.key === "t:t4")?.label).toBe("Pruebas API");
    expect(named.find((it) => it.key === "t:t4")?.hint).toBe("Shell · x/beta · en marcha");
    expect(found("pruebas api")).toEqual(["t:t4"]);
    expect(found("shell")).toEqual(["t:t4"]);
  });

  test("no query lists everything, capped per group", () => {
    expect(matchItems(items, "").length).toBe(items.length);
    expect(matchItems(items, "", 2).map((it) => it.key)).toEqual([
      "page:/",
      "page:/terminales",
      "t:t1",
      "t:t2",
      "n:env:env-a",
      "n:env:env-a/p-backend",
      "k:ABC-101",
      "pr:api#7",
    ]);
  });

  test("without projects the terminals still say their folder", () => {
    const bare = buildItems({ terminals: [terminal({ id: "t3", cwd: "/x/src/beta" })] });
    expect(bare.find((it) => it.key === "t:t3")?.hint).toBe("src/beta · en marcha");
    expect(bare.some((it) => it.group === "Proyectos")).toBe(false);
  });
});
