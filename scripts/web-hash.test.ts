import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webSourceHash } from "./web-hash.ts";

test("the hash follows what the page is built from, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "web-hash-"));
  try {
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put("web/app.tsx", "a");
    put("shared/x.ts", "b");
    put("server/app.ts", "c");
    put("package.json", "{}");
    const first = webSourceHash(root);
    expect(webSourceHash(root)).toBe(first);
    put("server/app.ts", "changed");
    put("web/app.test.tsx", "a test");
    expect(webSourceHash(root)).toBe(first);
    put("shared/x.ts", "changed");
    const second = webSourceHash(root);
    expect(second).not.toBe(first);
    put("web/new.css", "");
    expect(webSourceHash(root)).not.toBe(second);
    put("bun.lock", "packages");
    expect(webSourceHash(root)).not.toBe(second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
