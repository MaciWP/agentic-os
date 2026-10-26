import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Manifest = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  config: z.boolean().default(false),
  folders: z.array(z.enum(["notes", "memory", "prompts", "consultations", "recovery", "pastes"])),
});

export function backupDatabase(db: Database, destination: string) {
  if (existsSync(destination)) throw new Error("backup destination already exists");
  db.query("VACUUM main INTO ?").run(destination);
  chmodSync(destination, 0o600);
  const verify = new Database(destination, { readonly: true });
  try {
    if (Object.values(verify.query("PRAGMA integrity_check").get() ?? {})[0] !== "ok")
      throw new Error("backup integrity check failed");
  } finally {
    verify.close();
  }
}

// Full backups (backupData) kept in data/backups; older ones are removed by the next.
export const BACKUP_KEEP = 5;
const FULL_BACKUP = /^(\d+)-[0-9a-f-]{36}$/;

// Keeps the `keep` newest entries of `root` whose name matches `pattern`, ordered by the
// timestamp its first group captures. Anything else in the folder is never touched.
export function pruneBackups(root: string, pattern: RegExp, keep: number) {
  const stamped = readdirSync(root)
    .map((name) => ({ name, at: Number(pattern.exec(name)?.[1] ?? Number.NaN) }))
    .filter((b) => !Number.isNaN(b.at))
    .sort((a, b) => b.at - a.at);
  for (const old of stamped.slice(keep))
    rmSync(join(root, old.name), { recursive: true, force: true });
}

// Application data only. Repository worktrees and harness credential stores are excluded.
export function backupData(db: Database, dataDir: string) {
  const dir = join(dataDir, "backups", `${Date.now()}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  backupDatabase(db, join(dir, "database.sqlite"));
  const folders: z.infer<typeof Manifest>["folders"] = [];
  for (const name of [
    "notes",
    "memory",
    "prompts",
    "consultations",
    "recovery",
    "pastes",
  ] as const) {
    const source = join(dataDir, name);
    if (!existsSync(source)) continue;
    if (!lstatSync(source).isDirectory())
      throw new Error(`backup source is not a directory: ${name}`);
    cpSync(source, join(dir, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (path) => !lstatSync(path).isSymbolicLink(),
    });
    folders.push(name);
  }
  const config = existsSync(join(dataDir, "config.json"));
  if (config) {
    copyFileSync(join(dataDir, "config.json"), join(dir, "config.json"), constants.COPYFILE_EXCL);
    chmodSync(join(dir, "config.json"), 0o600);
  }
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), config, folders }),
    { mode: 0o600, flag: "wx" },
  );
  pruneBackups(join(dataDir, "backups"), FULL_BACKUP, BACKUP_KEEP);
  return dir;
}

// Restore into a NEW data directory. Never overwrite a live app or replay historical runs.
export function restoreData(source: string, destination: string) {
  if (existsSync(destination) && readdirSync(destination).length)
    throw new Error("restore destination must be empty");
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")));
  const db = new Database(join(source, "database.sqlite"), { readonly: true });
  try {
    if (Object.values(db.query("PRAGMA integrity_check").get() ?? {})[0] !== "ok")
      throw new Error("invalid backup");
  } finally {
    db.close();
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copyFileSync(
    join(source, "database.sqlite"),
    join(destination, "agentic-os.db"),
    constants.COPYFILE_EXCL,
  );
  for (const name of manifest.folders)
    cpSync(join(source, name), join(destination, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (path) => !lstatSync(path).isSymbolicLink(),
    });
  if (manifest.config) {
    copyFileSync(
      join(source, "config.json"),
      join(destination, "config.json"),
      constants.COPYFILE_EXCL,
    );
    chmodSync(join(destination, "config.json"), 0o600);
  }
  const restored = new Database(join(destination, "agentic-os.db"));
  try {
    restored.run(
      "UPDATE terminal_sessions SET state='lost', session_id=NULL WHERE state='running'",
    );
  } finally {
    restored.close();
  }
  return destination;
}
