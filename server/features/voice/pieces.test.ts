import { describe, expect, test } from "bun:test";
import { hotwords, vocabulary } from "./pieces.ts";

describe("hotword pieces", () => {
  const vocab = vocabulary(
    "<unk> 0\n▁Po 1\nne 2\ngl 3\ny 4\nph 5\n▁B 6\nio 7\nme 8\n▁OS 9\n▁Agent 10\nic 11\n",
  );

  test("each term becomes the model's longest pieces; terms are joined with /", () => {
    expect(hotwords(["Poneglyph", "Biome", "Agentic OS"], vocab)).toBe(
      "▁Po ne gl y ph/▁B io me/▁Agent ic ▁OS",
    );
  });

  test("a term with a letter the model has no piece for is left out, not the line", () => {
    expect(hotwords(["Bioñ", "Biome", "  "], vocab)).toBe("▁B io me");
  });
});
