import { describe, expect, test } from "bun:test";
import { glossary, normalize } from "./normalize.ts";

describe("normalize", () => {
  test("the Jira key comes out whole however the model spaced it", () => {
    const n = (t: string) => normalize(t, { replace: {}, jiraProject: "ABC" });
    expect(n("Revisa el ticket ABC1077 y dime")).toBe("Revisa el ticket ABC-1077 y dime");
    expect(n("revisa abc 1077")).toBe("revisa ABC-1077");
    expect(n("ABC - 12 y ABC-13")).toBe("ABC-12 y ABC-13");
    // Not inside another word, and no key without a project.
    expect(n("XABC1077")).toBe("XABC1077");
    expect(normalize("ABC 1077", { replace: {} })).toBe("ABC 1077");
    // Spelled out, as the model writes it.
    expect(n("que es ABC mil setenta y siete")).toBe("que es ABC-1077");
  });

  test("the user's fixes replace whole words, longest first, any case", () => {
    const replace = { "Van Runcheck": "bun run check", Biem: "Biome", "use query": "useQuery" };
    expect(normalize("Ejecuta van runcheck y arregla Biem", { replace })).toBe(
      "Ejecuta bun run check y arregla Biome",
    );
    expect(normalize("el hook Use Query falla", { replace })).toBe("el hook useQuery falla");
    // A fix is not a pattern: "$1" and dots are text.
    expect(normalize("pon a.b", { replace: { "a.b": "$1" } })).toBe("pon $1");
    expect(normalize("pon axb", { replace: { "a.b": "x" } })).toBe("pon axb");
    // Accented letters are letters: "dé" is not "d" plus a boundary.
    expect(normalize("dé de", { replace: { d: "D", de: "DE" } })).toBe("dé DE");
  });

  test("always one line with single spaces", () => {
    expect(normalize("  hola\n\nmundo \t ya ", { replace: {} })).toBe("hola mundo ya");
  });
});

describe("glossary", () => {
  test("terms, replace targets and the Jira key, once each whatever the case", () => {
    expect(
      glossary({
        terms: ["Poneglyph", "Biome", " "],
        replace: { "pone grif": "Poneglyph", usquery: "useQuery", biem: "biome" },
        jiraProject: "abc",
      }),
    ).toEqual(["Poneglyph", "Biome", "useQuery", "ABC"]);
  });
});
