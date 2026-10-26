import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "./process-lock.ts";

test("a second process cannot acquire a held lock, and crash releases it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-lock-"));
  const path = join(dir, "server.lock");
  const module = join(import.meta.dir, "process-lock.ts");
  const command = `import { acquireProcessLock } from ${JSON.stringify(module)}; const release = acquireProcessLock(${JSON.stringify(path)}); if (!release) process.exit(3); console.log('held'); setInterval(() => {}, 1000);`;
  const child = Bun.spawn([process.execPath, "-e", command], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    reader.releaseLock();
    expect(acquireProcessLock(path)).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    const release = acquireProcessLock(path);
    expect(release).not.toBeNull();
    release?.();
    release?.();
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
