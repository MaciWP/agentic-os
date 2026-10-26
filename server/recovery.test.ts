import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveRecovery } from "./recovery.ts";
import { RECOVERY_KEEP_MS } from "./retention.ts";

const dataDir = mkdtempSync(join(tmpdir(), "aos-recovery-"));
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

test("a save prunes the copies past the window, and only folders it named", async () => {
  const root = join(dataDir, "recovery");
  const folder = (name: string, ageMs: number) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(dir, at, at);
    return dir;
  };
  const day = 86_400_000;
  const old = folder(crypto.randomUUID(), RECOVERY_KEEP_MS + day);
  const recent = folder(crypto.randomUUID(), RECOVERY_KEEP_MS - day);
  const foreign = folder("kept-by-hand", RECOVERY_KEEP_MS + day);
  const id = await saveRecovery(dataDir, "/w/a.md", "note-delete", new TextEncoder().encode("x"));
  expect(existsSync(join(root, id, "content"))).toBe(true);
  expect([old, recent, foreign].map(existsSync)).toEqual([false, true, true]);
});
