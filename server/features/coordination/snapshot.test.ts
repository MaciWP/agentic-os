import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSnapshot } from "./snapshot.ts";

test("snapshot includes dirty and untracked code, excludes ignored files, survives later edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-snapshot-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, ...args]);
    expect(r.exitCode).toBe(0);
  };
  git("init");
  writeFileSync(join(root, ".gitignore"), "ignored\n");
  writeFileSync(join(root, "code.ts"), "before");
  git("add", ".");
  writeFileSync(join(root, "code.ts"), "dirty");
  writeFileSync(join(root, "new.ts"), "new");
  writeFileSync(join(root, "ignored"), "private");
  symlinkSync("/etc/passwd", join(root, "escape"));
  const destination = join(mkdtempSync(join(tmpdir(), "aos-query-")), "snapshot");
  const result = await captureSnapshot(
    root,
    destination,
    { ...process.env } as Record<string, string>,
    "git",
  );
  expect(readFileSync(join(destination, "code.ts"), "utf8")).toBe("dirty");
  expect(readFileSync(join(destination, "new.ts"), "utf8")).toBe("new");
  expect(result.files.map((f) => f.path)).not.toContain("ignored");
  expect(result.excluded).toContain("escape");
  writeFileSync(join(root, "code.ts"), "after");
  expect(readFileSync(join(destination, "code.ts"), "utf8")).toBe("dirty");
  expect(result.fingerprint).toHaveLength(64);
});

test("a checkout that changes during the second inventory is refused", async () => {
  const { chmodSync, mkdirSync, rmSync } = await import("node:fs");
  const area = mkdtempSync(join(tmpdir(), "aos-snapshot-race-"));
  const root = join(area, "repo");
  mkdirSync(root);
  Bun.spawnSync(["git", "init", root]);
  writeFileSync(join(root, "code.ts"), "before");
  const wrapper = join(area, "git-fixture");
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nconst fs = require('fs'); const args=process.argv.slice(2); const counter=${JSON.stringify(join(area, "count"))}; if (args[0]==='ls-files') { const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0; fs.writeFileSync(counter,String(n+1)); if(n===1) fs.writeFileSync(${JSON.stringify(join(root, "code.ts"))},'changed'); } const p=Bun.spawnSync(['/usr/bin/git',...args],{stdout:'inherit',stderr:'inherit'}); process.exit(p.exitCode);\n`,
  );
  chmodSync(wrapper, 0o700);
  try {
    await expect(
      captureSnapshot(root, join(area, "snapshot"), { PATH: "/usr/bin:/bin" }, wrapper),
    ).rejects.toThrow("snapshot_changed");
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});
