import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

// Every file `entry` reaches through relative imports, depth first, entry included. Only
// imports that run: Bun's scanner drops `import type`, which never loads at runtime.
export function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const { path } of transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(code))
      if (path.startsWith(".")) walk(Bun.resolveSync(path, dirname(file)));
  };
  walk(entry);
  return [...seen];
}
