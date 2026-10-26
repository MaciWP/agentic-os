import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

// Imports that point back down the feature graph, kept until their owner cuts them. The test
// fails on a new one, and on a listed one that is gone, so the list only shrinks.
const PENDING: Record<string, { owner: string; why: string }> = {};

const featureOf = (file: string) => /^server\/features\/([^/]+)\//.exec(file)?.[1];

// Feature -> the features its shipped files import at runtime. `import type` is dropped by
// Bun's scanner and never loads, so it is no edge; tests may reach across features freely.
function featureEdges(): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const file of new Bun.Glob("server/features/**/*.{ts,tsx}").scanSync(root)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const from = featureOf(file) as string;
    const to = edges.get(from) ?? new Set<string>();
    edges.set(from, to);
    const code = readFileSync(join(root, file), "utf8");
    for (const { path } of transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(code)) {
      if (!path.startsWith(".")) continue;
      const target = featureOf(relative(root, Bun.resolveSync(path, dirname(join(root, file)))));
      if (target && target !== from) to.add(target);
    }
  }
  return edges;
}

// The groups of features that reach one another (Tarjan's strongly connected components).
function cycles(edges: Map<string, Set<string>>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (stack.includes(w))
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    let w: string | undefined;
    do {
      w = stack.pop() as string;
      group.push(w);
    } while (w !== v);
    if (group.length > 1) found.push(group.sort());
  };
  for (const v of edges.keys()) if (!index.has(v)) visit(v);
  return found;
}

describe("feature imports", () => {
  const edges = featureEdges();

  test("no feature reaches itself through other features", () => {
    const cut = new Map([...edges].map(([from, to]) => [from, new Set(to)]));
    for (const edge of Object.keys(PENDING)) {
      const [from, to] = edge.split("->") as [string, string];
      cut.get(from)?.delete(to);
    }
    expect(cycles(cut)).toEqual([]);
  });

  test("every pending edge still exists", () => {
    const gone = Object.keys(PENDING).filter((edge) => {
      const [from, to] = edge.split("->") as [string, string];
      return !edges.get(from)?.has(to);
    });
    expect(gone).toEqual([]);
  });

  test("the cycle finder sees a cycle of any length", () => {
    const ring = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set(["a"])],
      ["d", new Set(["a"])],
    ]);
    expect(cycles(ring)).toEqual([["a", "b", "c"]]);
    expect(cycles(new Map([["a", new Set(["b"])]]))).toEqual([]);
  });
});
