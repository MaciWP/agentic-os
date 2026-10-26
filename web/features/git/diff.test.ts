import { describe, expect, test } from "bun:test";
import { diffStats, parseDiff, splitRows, wordDiff } from "./diff.ts";

const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+TWO",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseDiff", () => {
  test("file headers are meta, hunks and their lines get their own class", () => {
    expect(parseDiff(DIFF).map((l) => l.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "context",
      "del",
      "add",
      "meta",
    ]);
  });

  test("a second file's headers are meta again, never a change", () => {
    const two = `${DIFF}diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n`;
    const kinds = parseDiff(two).map((l) => l.kind);
    expect(kinds.slice(9)).toEqual(["meta", "meta", "meta", "hunk", "del", "add"]);
  });

  test("each side's line numbers follow the hunk header, and hunks are counted", () => {
    const diff =
      "@@ -10,3 +20,4 @@ f()\n ctx\n-gone\n+new a\n+new b\n ctx2\n@@ -40 +50 @@\n-x\n+y\n";
    const lines = parseDiff(diff).map((l) => [l.kind, l.old, l.new, l.hunk]);
    expect(lines).toEqual([
      ["hunk", null, null, 0],
      ["context", 10, 20, 0],
      ["del", 11, null, 0],
      ["add", null, 21, 0],
      ["add", null, 22, 0],
      ["context", 12, 23, 0],
      ["hunk", null, null, 1],
      ["del", 40, null, 1],
      ["add", null, 50, 1],
    ]);
    expect(diffStats(parseDiff(diff))).toEqual({ add: 3, del: 2 });
  });

  test("a removed line and the added one in its place mark the words that changed", () => {
    const [del, add] = parseDiff("@@ -1 +1 @@\n-const a = 1;\n+const b = 1;\n").slice(1);
    expect(del?.words).toEqual([
      { text: "const ", changed: false },
      { text: "a", changed: true },
      { text: " = 1;", changed: false },
    ]);
    expect(add?.words?.filter((w) => w.changed).map((w) => w.text)).toEqual(["b"]);
  });

  test("a diff at the size cap marks words only within its budget, and keeps every line", () => {
    const line = (shift: number) =>
      Array.from({ length: 190 }, (_, i) => `w${(i * 7 + shift) % 97}`).join(" ");
    const dels = Array.from({ length: 300 }, (_, k) => `-${line(k)}`);
    const adds = Array.from({ length: 300 }, (_, k) => `+${line(k + 1)}`);
    const diff = `@@ -1,300 +1,300 @@\n${[...dels, ...adds].join("\n")}\n`;
    expect(diff.length).toBeGreaterThan(400_000);
    const lines = parseDiff(diff).slice(1);
    for (const l of lines) expect(l.words?.map((w) => w.text).join("")).toBe(l.text.slice(1));
    // The first pairs are marked word by word; once the budget is spent, whole lines.
    expect(lines[0]?.words?.some((w) => !w.changed)).toBe(true);
    expect(lines[299]?.words).toEqual([{ text: line(299), changed: true }]);
  });
});

describe("wordDiff", () => {
  test("identical lines change nothing; a very long line is marked whole", () => {
    expect(wordDiff("same", "same")).toEqual([
      [{ text: "same", changed: false }],
      [{ text: "same", changed: false }],
    ]);
    const long = "x ".repeat(500);
    expect(wordDiff(long, `${long}y`)[1]).toEqual([{ text: `${long}y`, changed: true }]);
  });
});

describe("splitRows", () => {
  test("context on both sides, a removed run beside the added run, headers across", () => {
    const rows = splitRows(parseDiff("@@ -1,3 +1,2 @@\n a\n-b\n-c\n+B\n d\n"));
    expect(
      rows.map((r) =>
        r.kind === "full" ? r.line.kind : [r.left?.text ?? null, r.right?.text ?? null],
      ),
    ).toEqual(["hunk", [" a", " a"], ["-b", "+B"], ["-c", null], [" d", " d"]]);
  });
});
