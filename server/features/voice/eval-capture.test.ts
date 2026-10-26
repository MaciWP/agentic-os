import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepDictations, wav } from "./eval-capture.ts";

describe("eval capture", () => {
  test("a dictation is kept as a 16 kHz mono WAV next to what was heard", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "voice-eval-")), "set");
    try {
      const pcm = Buffer.from([1, 0, 2, 0]);
      await keepDictations(dir, () => new Date("2026-10-13T08:00:00.000Z"))(pcm, {
        raw: "abc 12",
        text: "ABC-12",
      });
      expect((await readdir(dir)).sort()).toEqual([
        "2026-10-13T08-00-00-000Z.json",
        "2026-10-13T08-00-00-000Z.wav",
      ]);
      const file = await readFile(join(dir, "2026-10-13T08-00-00-000Z.wav"));
      expect(file.subarray(0, 4).toString()).toBe("RIFF");
      expect(file.readUInt32LE(24)).toBe(16_000);
      expect(file.readUInt16LE(22)).toBe(1);
      expect(file.subarray(44)).toEqual(pcm);
      expect(
        JSON.parse(await readFile(join(dir, "2026-10-13T08-00-00-000Z.json"), "utf8")),
      ).toEqual({ raw: "abc 12", text: "ABC-12" });
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("the header says how long the data is", () => {
    const file = wav(Buffer.alloc(10));
    expect(file.readUInt32LE(4)).toBe(46);
    expect(file.readUInt32LE(40)).toBe(10);
  });
});
