import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { APP_ROOT } from "../server/config.ts";

// Dead code guard: an export that no other shipped file names, and its own file never uses,
// is dead. Tests do not keep code alive: a block only its test renders still ships nothing.
// A word match, not a parser (TypeScript 7 has no JS API): a name in a comment counts as a use,
// and `export { … }` lists and default exports are not checked.
const DECLARATION = /^export (?:async )?(?:function|const|let|class|type|interface) (\w+)/gm;
const NOT_SHIPPED = /(\.(test|e2e)\.tsx?$)|(\/test-[\w-]+\.tsx?$)/;

function deadExports(sources: Map<string, string>): string[] {
  const shipped = [...sources.keys()].filter((f) => !NOT_SHIPPED.test(f));
  const dead: string[] = [];
  for (const file of shipped) {
    const text = sources.get(file) ?? "";
    for (const [, name] of text.matchAll(DECLARATION)) {
      const word = new RegExp(`\\b${name}\\b`);
      if ((text.match(new RegExp(word, "g")) ?? []).length > 1) continue;
      if (shipped.some((other) => other !== file && word.test(sources.get(other) ?? ""))) continue;
      dead.push(`${file}: ${name}`);
    }
  }
  return dead;
}

describe("unused exports", () => {
  test("an export nobody ships with, and its file never uses, is reported", () => {
    const sources = new Map([
      [
        "web/a.tsx",
        "export function Used() {}\nexport function Dead() {}\nexport const own = 1;\nown;",
      ],
      ["web/b.tsx", 'import { Used } from "./a.tsx";'],
      ["web/a.test.tsx", 'import { Dead } from "./a.tsx";'],
      ["web/test-render.tsx", "export function helper() {}"],
    ]);
    expect(deadExports(sources)).toEqual(["web/a.tsx: Dead"]);
  });

  test("the shipped tree has none", () => {
    const files = new Glob("{web,server,shared,scripts}/**/*.{ts,tsx}").scanSync(APP_ROOT);
    const sources = new Map([...files].map((f) => [f, readFileSync(join(APP_ROOT, f), "utf8")]));
    expect(deadExports(sources)).toEqual([]);
  });
});
