import { Database } from "bun:sqlite";
import { constants, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { backupData, restoreData } from "../server/backup.ts";
import { DATA_DIR } from "../server/config.ts";
import { errorMessage } from "../server/error-message.ts";
import { hostPaths, isHostPid, readHostFile } from "../server/host/files.ts";
import { acquireProcessLock } from "../server/process-lock.ts";

const [command, source, target] = process.argv.slice(2);
const Recovery = z.object({
  id: z.string().uuid(),
  path: z.string(),
  kind: z.string(),
  version: z.string(),
  createdAt: z.string(),
});
try {
  if (command === "backup") {
    const release = acquireProcessLock(join(DATA_DIR, "server.lock"));
    if (!release) throw new Error("Stop the app server before a full backup.");
    let hostRelease: (() => void) | null = null;
    try {
      const paths = hostPaths(DATA_DIR);
      const host = readHostFile(paths.file);
      hostRelease = acquireProcessLock(paths.lock);
      if (!hostRelease || (host && (await isHostPid(host.pid))))
        throw new Error("Wait for the idle PTY host to stop before a full backup.");
      const db = new Database(join(DATA_DIR, "agentic-os.db"), { readonly: true });
      try {
        console.log(backupData(db, DATA_DIR));
      } finally {
        db.close();
      }
    } finally {
      hostRelease?.();
      release();
    }
  } else if (command === "restore" && source && target) {
    if (!isAbsolute(target)) throw new Error("Use an absolute NEW destination directory.");
    console.log(restoreData(resolve(source), target));
  } else if (command === "recovery-list") {
    const root = join(DATA_DIR, "recovery");
    for (const id of readdirSync(root)) {
      if (!z.string().uuid().safeParse(id).success) continue;
      console.log(
        JSON.stringify(
          Recovery.parse(JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8"))),
        ),
      );
    }
  } else if (command === "recovery-export" && source && target) {
    const id = z.string().uuid().parse(source);
    // Export to a new file. Replacing the working file is always an explicit user action.
    copyFileSync(
      join(DATA_DIR, "recovery", id, "content"),
      resolve(target),
      constants.COPYFILE_EXCL,
    );
    console.log(resolve(target));
  } else
    throw new Error(
      "Usage: bun scripts/data.ts backup | restore <backup> <new-absolute-dir> | recovery-list | recovery-export <id> <new-file>",
    );
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
