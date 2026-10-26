import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

// Layer rules over the source tree, read the way Bun loads it: `scanImports` lists only the
// imports that run, so `import type` and `import { type X }` are free to cross layers.
// Files still breaking a rule are named in its PENDING list and leave it as they are fixed;
// any other file that breaks it fails the test.
const ROOT = join(import.meta.dir, "..");
const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};
// Read once, at load and outside any test's timeout: the machine is often busy.
const TREE = new Map(
  [...new Glob("{web,shared}/**/*.{ts,tsx}").scanSync(ROOT)]
    .sort()
    .map((f) => [f, readFileSync(join(ROOT, f), "utf8")]),
);
const files = (dir: string) => [...TREE.keys()].filter((f) => f.startsWith(`${dir}/`));
const source = (file: string) => TREE.get(file) ?? "";

// The repo files `file` imports at runtime, as paths from the root.
function runtimeImports(file: string, code = source(file)): string[] {
  return transpilers[file.endsWith(".tsx") ? "tsx" : "ts"]
    .scanImports(code)
    .map(({ path }) =>
      path.startsWith("@/")
        ? join("web", path.slice(2))
        : path.startsWith(".")
          ? relative(ROOT, resolve(ROOT, dirname(file), path))
          : null,
    )
    .filter((path): path is string => path !== null);
}

const crossing = (dir: string, allowed: (to: string) => boolean) =>
  files(dir).flatMap((f) =>
    runtimeImports(f)
      .filter((to) => !allowed(to))
      .map((to) => `${f} -> ${to}`),
  );

describe("layers", () => {
  test("the scan sees runtime imports and skips type-only ones", () => {
    const code = [
      'import type { A } from "../server/a.ts";',
      'import { type B } from "../server/b.ts";',
      'import { C } from "../server/c.ts";',
      'import { D } from "@/d.ts";',
      'import { z } from "zod";',
    ].join("\n");
    expect(runtimeImports("web/x.ts", code)).toEqual(["server/c.ts", "web/d.ts"]);
  });

  test("web/ takes only types from server/", () => {
    expect(crossing("web", (to) => !to.startsWith("server/"))).toEqual([]);
  });

  test("shared/ imports nothing else from the repo", () => {
    expect(crossing("shared", (to) => to.startsWith("shared/"))).toEqual([]);
  });
});

// web/storage.ts is the only door to browser storage (its own test stubs the browser's).
const STORAGE_PENDING: string[] = [];
const STORAGE_SELF = ["web/storage.ts", "web/storage.test.ts"];

describe("browser storage", () => {
  test("no web file but web/storage.ts touches localStorage or sessionStorage", () => {
    const touching = files("web").filter(
      (f) => !STORAGE_SELF.includes(f) && /\b(localStorage|sessionStorage)\b/.test(source(f)),
    );
    expect(touching).toEqual(STORAGE_PENDING);
  });

  test("every key is a literal that starts with aos. and is declared once", () => {
    const names: string[] = [];
    const bad: string[] = [];
    for (const f of files("web").filter((f) => !STORAGE_SELF.includes(f))) {
      const code = source(f);
      for (const m of code.matchAll(/\bstorage(?:Key|Family)\s*(?:<[^>(]*>)?\(\s*/g)) {
        const rest = code.slice(m.index + m[0].length);
        const name = /^"(aos\.[^"]+)"/.exec(rest)?.[1];
        if (name) names.push(name);
        else bad.push(`${f}: ${rest.slice(0, 40)}`);
      }
    }
    expect(bad).toEqual([]);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    // ADR 0013 names the owner of every key; a key it does not list has no written owner.
    const adr = readFileSync(join(ROOT, "docs/adr/0013-state-ownership.md"), "utf8");
    expect(names.filter((n) => !adr.includes(`\`${n}`))).toEqual([]);
  });
});

// State a web module keeps lives in a web/store.ts store, never in a loose module-level `let`,
// nor in a module-level collection. UPPER_CASE ones are fixed tables; a lowercase one holds
// state unless it is a cache or a registry named here, which no view ever reads.
const MODULE_STATE_PENDING: string[] = [];
const MODULE_CACHES = [
  "web/storage.ts: swapped", // test seam that swaps the browser's storage
  "web/motion.ts: spinners", // elements the shared spinner timer animates
  "web/report.ts: sent", // failures this tab already reported
  "web/features/tickets/queries.ts: boards", // one query definition per board
  "web/features/terminals/renderer.ts: drawn", // the WebGL addon of each xterm
  "web/features/terminals/renderer.ts: loading", // xterms whose addon is loading
  "web/features/terminals/renderer.ts: contexts", // each addon's WebGL context, to let it go
  "web/features/code/tokens.ts: loading", // grammars being loaded
];

test("no web module keeps state in a module-level let or var", () => {
  const loose = files("web").filter(
    (f) =>
      f !== "web/store.ts" && !/\.test\.tsx?$/.test(f) && /^(export )?(let|var) /m.test(source(f)),
  );
  expect(loose).toEqual(MODULE_STATE_PENDING);
});

// ADR 0013 names the owner of every module store: a file that keeps one and has no row there
// has no written owner.
test("every web module that keeps a store has its row in ADR 0013", () => {
  const adr = readFileSync(join(ROOT, "docs/adr/0013-state-ownership.md"), "utf8");
  // Only the module-stores section counts: a browser-storage row is another owner.
  const table = adr.slice(adr.indexOf("## Module stores"), adr.indexOf("## Consequences"));
  const owners = files("web").filter(
    (f) =>
      f !== "web/store.ts" && !/\.test\.tsx?$/.test(f) && /\bcreateStore\s*[<(]/.test(source(f)),
  );
  expect(owners.length).toBeGreaterThan(10);
  expect(table).toContain("| State | Owner (only writer) |");
  expect(owners.filter((f) => !table.includes(`| \`${f}\``))).toEqual([]);
});

test("no web module keeps state in a module-level Map or Set", () => {
  const held = files("web")
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .flatMap((f) =>
      [
        ...source(f).matchAll(
          /^(?:export )?const ([a-z]\w*)(?:: [^=]+)? = new (?:Map|Set|WeakMap|WeakSet)\b/gm,
        ),
      ].map((m) => `${f}: ${m[1]}`),
    );
  expect(held.sort()).toEqual([...MODULE_CACHES].sort());
});
