import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

// What the page in dist/ is built from: web/ and shared/ (web takes only types from server/,
// scripts/layers.test.ts), the build config and the installed packages. Tests are never
// bundled. Paths are sorted and hashed with their content, so the same tree hashes the same.
const TREES = ["web", "shared"];
const FILES = ["vite.config.ts", "package.json", "bun.lock", "tsconfig.json"];
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

// The stamp `bun run refresh` writes beside a complete build.
export const STAMP = "source.sha256";

export function webSourceHash(root: string): string {
  const paths = [
    ...TREES.flatMap((tree) =>
      existsSync(join(root, tree))
        ? [...new Glob("**/*").scanSync({ cwd: join(root, tree) })].map((p) => `${tree}/${p}`)
        : [],
    ).filter((p) => !isTest(p)),
    ...FILES.filter((f) => existsSync(join(root, f))),
  ].sort();
  const hash = createHash("sha256");
  for (const p of paths)
    hash
      .update(`${p}\0`)
      .update(readFileSync(join(root, p)))
      .update("\0");
  return hash.digest("hex");
}
