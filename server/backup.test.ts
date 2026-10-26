import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BACKUP_KEEP, backupData, restoreData } from "./backup.ts";
import { openDb } from "./db.ts";

test("backup captures committed WAL data and files; restore never overwrites or replays running terminals", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-backup-"));
  const data = join(root, "data");
  mkdirSync(join(data, "notes"), { recursive: true });
  const db = openDb(join(data, "agentic-os.db"));
  try {
    writeFileSync(join(data, "notes", "hello.md"), "hello");
    writeFileSync(join(data, "config.json"), "{}");
    db.run("INSERT INTO workspace_state VALUES (1,1,'[]')");
    db.run(
      "INSERT INTO terminal_sessions (id,harness,location,cwd,state,started_at,session_id) VALUES ('old','claude','app','/tmp','running','2026-10-07','historical-session')",
    );
    const reader = new Database(join(data, "agentic-os.db"), { readonly: true });
    const copy = backupData(reader, data);
    reader.close();
    db.run("UPDATE workspace_state SET revision=2");
    const destination = join(root, "restored");
    restoreData(copy, destination);
    const restored = new Database(join(destination, "agentic-os.db"), { readonly: true });
    expect(restored.query("SELECT revision FROM workspace_state").get()).toEqual({ revision: 1 });
    expect(
      restored.query("SELECT state,session_id FROM terminal_sessions WHERE id='old'").get(),
    ).toEqual({ state: "lost", session_id: null });
    restored.close();
    expect(readFileSync(join(destination, "notes", "hello.md"), "utf8")).toBe("hello");
    expect(readFileSync(join(destination, "config.json"), "utf8")).toBe("{}");
    expect(() => restoreData(copy, destination)).toThrow("must be empty");
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});

test("full backups keep only the last few, and never touch other files in backups/", () => {
  const data = mkdtempSync(join(tmpdir(), "aos-backup-prune-"));
  const db = openDb(join(data, "agentic-os.db"));
  try {
    mkdirSync(join(data, "backups"), { recursive: true });
    writeFileSync(join(data, "backups", "config.json.pre-remote"), "{}");
    const made = Array.from({ length: BACKUP_KEEP + 2 }, () => backupData(db, data));
    const left = readdirSync(join(data, "backups")).sort();
    expect(left).toEqual(
      ["config.json.pre-remote", ...made.slice(-BACKUP_KEEP).map((d) => basename(d))].sort(),
    );
  } finally {
    db.close();
    rmSync(data, { recursive: true });
  }
});
