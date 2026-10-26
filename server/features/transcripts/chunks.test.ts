import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedChunks } from "./chunks.ts";
import { writeWav } from "./test-wav.ts";

test("only closed chunks are found, in order, each starting where the ones before end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chunks-"));
  writeWav(join(dir, "system", "000.wav"), 4);
  writeWav(join(dir, "system", "001.wav"), 2);
  writeFileSync(join(dir, "system", "002.wav.part"), "still being written");
  writeWav(join(dir, "mic", "000.wav"), 3);
  expect(await closedChunks(dir, "system")).toEqual([
    { track: "system", idx: 0, offset: 0, duration: 4 },
    { track: "system", idx: 1, offset: 4, duration: 2 },
  ]);
  expect((await closedChunks(dir, "mic")).length).toBe(1);
  expect(await closedChunks(join(dir, "nowhere"), "mic")).toEqual([]);
});
