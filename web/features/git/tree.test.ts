import { describe, expect, test } from "bun:test";
import type { GitFile } from "./queries.ts";
import { buildTree, filesUnder, type TreeNode } from "./tree.ts";

const f = (path: string): GitFile => ({ path, orig: null, x: ".", y: "M", kind: "changed" });

// The tree as names and nesting, to compare at a glance.
const shape = (nodes: TreeNode[]): unknown[] =>
  nodes.map((n) => (n.kind === "file" ? n.name : { [n.name]: shape(n.children) }));

describe("buildTree", () => {
  test("folders first then files, by name; one-child folders show as one row", () => {
    const tree = buildTree([
      f("z.ts"),
      f("server/features/git/stage.ts"),
      f("server/features/git/run.ts"),
      f("web/a.tsx"),
      f("web/lib/b.ts"),
      f("a.md"),
    ]);
    expect(shape(tree)).toEqual([
      { "server/features/git": ["run.ts", "stage.ts"] },
      { web: [{ lib: ["b.ts"] }, "a.tsx"] },
      "a.md",
      "z.ts",
    ]);
  });

  test("a nested repo stays one leaf with its slash; filesUnder lists a folder's files", () => {
    const tree = buildTree([f("vendor/inner/"), f("vendor/x.ts")]);
    expect(shape(tree)).toEqual([{ vendor: ["inner/", "x.ts"] }]);
    expect(filesUnder(tree[0] as TreeNode).map((x) => x.path)).toEqual([
      "vendor/inner/",
      "vendor/x.ts",
    ]);
  });
});
