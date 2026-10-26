import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RECOVERY_KEEP_MS } from "./retention.ts";

export const contentVersion = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

// Never follow a final symlink or read an unbounded file before a destructive operation.
export async function fileVersion(path: string): Promise<{ bytes: Uint8Array; version: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error("file cannot be recovered safely");
    const bytes = await file.readFile();
    if (bytes.length > 64 * 1024 * 1024) throw new Error("file grew beyond the recovery limit");
    return { bytes, version: contentVersion(bytes) };
  } finally {
    await file.close();
  }
}

// A failed backup aborts the caller's destructive operation. Copies older than
// RECOVERY_KEEP_MS leave on the next save; a failed prune never fails the save.
export async function saveRecovery(
  dataDir: string,
  path: string,
  kind: "git-discard" | "note-delete",
  bytes: Uint8Array,
) {
  const id = randomUUID();
  const dir = join(dataDir, "recovery", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "content"), bytes, { flag: "wx", mode: 0o600 });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      path,
      kind,
      version: contentVersion(bytes),
      createdAt: new Date().toISOString(),
    }),
    { flag: "wx", mode: 0o600 },
  );
  await pruneRecovery(join(dataDir, "recovery"), Date.now());
  return id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Only folders saveRecovery named; their age is the folder's, set when the copy was written.
async function pruneRecovery(root: string, now: number) {
  for (const name of await readdir(root).catch(() => [])) {
    if (!UUID.test(name)) continue;
    const dir = join(root, name);
    const s = await lstat(dir).catch(() => null);
    if (s?.isDirectory() && now - s.mtimeMs > RECOVERY_KEEP_MS)
      await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
