import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "./process-lock.ts";

test("a duplicate owner or occupied port cannot open or migrate the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-startup-"));
  const dbPath = join(dir, "agentic-os.db");
  const db = new Database(dbPath);
  db.run("CREATE TABLE sentinel (n INTEGER)");
  db.close();
  const before = readFileSync(dbPath);
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ port: busy.port, providers: { github: false } }),
  );
  const start = () =>
    Bun.spawn([process.execPath, join(import.meta.dir, "index.ts")], {
      env: { ...process.env, AGENTIC_OS_DATA: dir },
      stdout: "ignore",
      stderr: "pipe",
    });
  try {
    const release = acquireProcessLock(join(dir, "server.lock"));
    if (!release) throw new Error("test lock unavailable");
    const duplicate = start();
    expect(await duplicate.exited).toBe(3);
    expect(await new Response(duplicate.stderr).text()).toContain("owns this data");
    expect(readFileSync(dbPath)).toEqual(before);
    release();
    const occupied = start();
    expect(await occupied.exited).toBe(1);
    expect(readFileSync(dbPath)).toEqual(before);
  } finally {
    await busy.stop(true);
    rmSync(dir, { recursive: true });
  }
});
