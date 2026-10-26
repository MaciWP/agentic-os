import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { backupDatabase, pruneBackups } from "./backup.ts";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
// Each pending migration first copies the whole DB; these many copies are kept.
export const PRE_MIGRATION_KEEP = 3;
const PRE_MIGRATION = /^pre-migration-(\d+)-[0-9a-f-]{36}\.sqlite$/;

// "migrate" applies pending migrations: the server, the one process that migrates. "check"
// refuses a DB with any pending, without writing: the PTY host, which the server starts after
// it has migrated.
export function openDb(
  path: string,
  migrationsDir = MIGRATIONS_DIR,
  mode: "migrate" | "check" = "migrate",
): Database {
  const file = path !== ":memory:";
  // Prompts, notes and terminal names: this user's only. SQLite gives the -wal and -shm files
  // the main file's mode, and an older version may have left any of them 0644.
  if (file) closeSync(openSync(path, "a", 0o600));
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  if (file)
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  if (mode === "migrate") {
    migrate(db, migrationsDir, file ? dirname(path) : undefined);
    return db;
  }
  const missing = pendingMigrations(db, migrationsDir);
  if (missing.length) {
    db.close();
    throw new Error(`${path} lacks migrations ${missing.join(", ")}; the server applies them`);
  }
  return db;
}

function pendingMigrations(db: Database, dir: string): string[] {
  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  const applied = new Set(
    table
      ? db
          .query<{ version: string }, []>("SELECT version FROM schema_migrations")
          .all()
          .map((r) => r.version)
      : [],
  );
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f) && !applied.has(f))
    .sort();
}

export function migrate(db: Database, dir: string, dataDir?: string): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const pending = pendingMigrations(db, dir);
  const fresh = !db.query("SELECT 1 FROM schema_migrations").get();
  if (pending.length && !fresh && dataDir) {
    const root = join(dataDir, "backups");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    backupDatabase(db, join(root, `pre-migration-${Date.now()}-${crypto.randomUUID()}.sqlite`));
    pruneBackups(root, PRE_MIGRATION, PRE_MIGRATION_KEEP);
  }
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    })();
  }
  return pending;
}
