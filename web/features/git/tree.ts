import type { GitFile } from "./queries.ts";

export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; file: GitFile };

type Dir = Extract<TreeNode, { kind: "dir" }>;

// The changed files as folders, as an editor shows them: folders first, then files, by name;
// a folder whose only child is a folder shows as one row ("server/features/git"). A nested
// repo or an empty dir is listed by git with a trailing slash and stays one leaf.
export function buildTree(files: GitFile[]): TreeNode[] {
  const root: Dir = { kind: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const nested = file.path.endsWith("/");
    const parts = (nested ? file.path.slice(0, -1) : file.path).split("/");
    const name = `${parts.pop() ?? ""}${nested ? "/" : ""}`;
    let at = root;
    for (const part of parts) {
      const path = at.path ? `${at.path}/${part}` : part;
      let next = at.children.find((c): c is Dir => c.kind === "dir" && c.path === path);
      if (!next) {
        next = { kind: "dir", name: part, path, children: [] };
        at.children.push(next);
      }
      at = next;
    }
    at.children.push({ kind: "file", name, file });
  }
  return tidy(root.children);
}

function tidy(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((n) => {
      if (n.kind === "file") return n;
      let dir = n;
      while (dir.children.length === 1 && dir.children[0]?.kind === "dir") {
        const only = dir.children[0];
        dir = { ...only, name: `${dir.name}/${only.name}` };
      }
      return { ...dir, children: tidy(dir.children) };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

// Every file under a node, in the tree's order.
export function filesUnder(node: TreeNode): GitFile[] {
  return node.kind === "file" ? [node.file] : node.children.flatMap(filesUnder);
}
