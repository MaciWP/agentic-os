import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, PRE_MIGRATION_KEEP } from "./db.ts";

test("applies each migration once, in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-mig-"));
  writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id INTEGER);");
  writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id INTEGER);");
  writeFileSync(join(dir, "notes.txt"), "ignored");
  const db = openDb(":memory:", dir);
  expect(migrate(db, dir)).toEqual([]);
  const versions = db.query<{ version: string }, []>("SELECT version FROM schema_migrations").all();
  expect(versions.map((v) => v.version)).toEqual(["001_a.sql", "002_b.sql"]);
});

test("the real migrations apply to an empty database", () => {
  const db = openDb(":memory:");
  expect(db.query("SELECT count(*) AS n FROM connections").get()).toEqual({ n: 0 });
});

const mode = (path: string) => statSync(path).mode & 0o777;

test("the database, its WAL and SHM are private, new or already there", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-db-mode-"));
  const path = join(dir, "agentic-os.db");
  const db = openDb(path);
  db.run("INSERT INTO workspace_state VALUES (1,1,'[]')");
  for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(mode(f)).toBe(0o600);
  db.close();
  // A file left 0644 by an older version is tightened on the next open.
  writeFileSync(join(dir, "old.db"), "", { mode: 0o644 });
  chmodSync(join(dir, "old.db"), 0o644);
  openDb(join(dir, "old.db")).close();
  expect(mode(join(dir, "old.db"))).toBe(0o600);
  rmSync(dir, { recursive: true, force: true });
});

test("only the server migrates: a check open refuses a database with pending migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-db-check-"));
  const migrations = join(dir, "migrations");
  mkdirSync(migrations);
  writeFileSync(join(migrations, "001_a.sql"), "CREATE TABLE a (id INTEGER);");
  const path = join(dir, "agentic-os.db");
  expect(() => openDb(path, migrations, "check")).toThrow(/001_a\.sql/);
  openDb(path, migrations).close();
  const checked = openDb(path, migrations, "check");
  expect(checked.query("SELECT count(*) AS n FROM a").get()).toEqual({ n: 0 });
  checked.close();
  writeFileSync(join(migrations, "002_b.sql"), "CREATE TABLE b (id INTEGER);");
  expect(() => openDb(path, migrations, "check")).toThrow(/002_b\.sql/);
  // Nothing was applied by the refused opens.
  const db = openDb(path, migrations);
  expect(db.query("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("pre-migration backups keep only the last few", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-db-prune-"));
  const migrations = join(dir, "migrations");
  mkdirSync(migrations);
  const path = join(dir, "agentic-os.db");
  for (let i = 1; i <= PRE_MIGRATION_KEEP + 2; i++) {
    writeFileSync(join(migrations, `00${i}_t.sql`), `CREATE TABLE t${i} (id INTEGER);`);
    openDb(path, migrations).close();
  }
  const kept = readdirSync(join(dir, "backups")).filter((f) => f.startsWith("pre-migration-"));
  expect(kept).toHaveLength(PRE_MIGRATION_KEEP);
  rmSync(dir, { recursive: true, force: true });
});
