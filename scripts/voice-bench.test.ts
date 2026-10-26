import { describe, expect, test } from "bun:test";
import { readRefs, termScore, wordErrors } from "./voice-bench.ts";

describe("voice bench", () => {
  test("word errors ignore case and punctuation and count edits", () => {
    expect(wordErrors("Revisa el hook, ya.", "revisa el hook ya")).toEqual({ errors: 0, words: 4 });
    // One substitution and one deletion.
    expect(wordErrors("pasa Biome antes del commit", "pasa bien antes commit")).toEqual({
      errors: 2,
      words: 5,
    });
  });

  test("terms count when said, and apart when written but never said", () => {
    const terms = ["Biome", "useQuery", "Agentic OS"];
    expect(termScore("pasa Biome en Agentic OS", "pasa bien en agentic os", terms)).toEqual({
      said: 2,
      hit: 1,
      invented: 0,
    });
    expect(termScore("abre el fichero", "abre useQuery", terms)).toEqual({
      said: 0,
      hit: 0,
      invented: 1,
    });
  });

  test("refs are id, tab, text; other lines are skipped", () => {
    const refs = readRefs("a\thola mundo\n\nsin tab\nb\tadiós \n");
    expect([...refs]).toEqual([
      ["a", "hola mundo"],
      ["b", "adiós"],
    ]);
  });
});
