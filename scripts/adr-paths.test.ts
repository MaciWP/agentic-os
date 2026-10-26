import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The state-ownership ADR is how a reviewer answers "who writes this?". A path it cites that no
// longer exists sends them to nothing, so every backticked repo path in it must exist. It names
// the code by symbol, `path` (`symbol`), because a line number goes stale with the next edit.
const ROOT = join(import.meta.dir, "..");
const ADR = "docs/adr/0013-state-ownership.md";
const PATH = String.raw`(?:server|web|shared|scripts|migrations|docs)\/[^\`\s:]+\.[a-z]+`;

function citedPaths(text: string): string[] {
  return [...text.matchAll(new RegExp(`\`(${PATH})\``, "g"))]
    .map((m) => m[1] as string)
    .filter((p, i, all) => all.indexOf(p) === i);
}

function lineRefs(text: string): string[] {
  return [...text.matchAll(new RegExp(`\`(${PATH}:\\d+)\``, "g"))].map((m) => m[1] as string);
}

// Each `path` (`a`, `b`, prose) pair, as [path, symbol].
function citedSymbols(text: string): [string, string][] {
  return [...text.matchAll(new RegExp(`\`(${PATH})\` \\(([^()]*)\\)`, "g"))].flatMap((m) =>
    [...(m[2] as string).matchAll(/`(\w+)`/g)].map((s): [string, string] => [
      m[1] as string,
      s[1] as string,
    ]),
  );
}

test("the scan reads paths, line references and symbols", () => {
  const text = "see `server/db.ts` (`migrate`, `KEEP`, host), `web/x.tsx:7` and `data/config.json`";
  expect(citedPaths(text)).toEqual(["server/db.ts"]);
  expect(lineRefs(text)).toEqual(["web/x.tsx:7"]);
  expect(citedSymbols(text)).toEqual([
    ["server/db.ts", "migrate"],
    ["server/db.ts", "KEEP"],
  ]);
});

const text = readFileSync(join(ROOT, ADR), "utf8");

test("every path ADR 0013 cites exists", () => {
  expect(citedPaths(text).filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
});

test("ADR 0013 cites no line numbers", () => {
  expect(lineRefs(text)).toEqual([]);
});

test("every symbol ADR 0013 names is in the file it names", () => {
  const missing = citedSymbols(text).filter(
    ([path, symbol]) =>
      !existsSync(join(ROOT, path)) ||
      !new RegExp(`\\b${symbol}\\b`).test(readFileSync(join(ROOT, path), "utf8")),
  );
  expect(citedSymbols(text).length).toBeGreaterThan(15);
  expect(missing).toEqual([]);
});
