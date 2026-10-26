import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { cleanEnv } from "./env.ts";
import { withModels } from "./models.ts";
import { TerminalManager } from "./pty.ts";

test("a Claude terminal lists with its launch model, so the page can say «Claude local»", async () => {
  const config = ConfigSchema.parse({
    ai: { machine: "win" },
    terminals: { shell: "/bin/sh", bins: { claude: "/usr/bin/true" } },
  });
  const db = openDb(":memory:");
  const manager = new TerminalManager(config, db, () =>
    Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {})),
  );
  const terminals = withModels(manager, db);
  try {
    const local = await terminals.create({ harness: "claude", location: "app", model: "local" });
    const plain = await terminals.create({ harness: "claude", location: "app" });
    const shell = await terminals.create({ harness: "shell", location: "app" });
    expect((await terminals.get(local.id))?.model).toBe("local");
    const listed = new Map((await terminals.list()).map((t) => [t.id, t.model]));
    expect(listed.get(local.id)).toBe("local");
    expect(listed.get(plain.id)).toBeNull();
    expect(listed.get(shell.id)).toBeUndefined();
  } finally {
    await manager.stopAll(200);
  }
});

test("a lost Claude local terminal resumes on the local model, never on the Anthropic login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-local-resume-"));
  const claude = join(dir, "claude");
  writeFileSync(
    claude,
    '#!/bin/sh\necho "BASE=$ANTHROPIC_BASE_URL TOKEN=$ANTHROPIC_AUTH_TOKEN ARGS=$*"\nsleep 5\n',
  );
  chmodSync(claude, 0o755);
  const config = ConfigSchema.parse({
    port: 4999,
    ai: { machine: "win" },
    terminals: { shell: "/bin/sh", bins: { claude } },
  });
  const db = openDb(":memory:");
  const manager = new TerminalManager(config, db, () =>
    Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {})),
  );
  const session = crypto.randomUUID();
  db.query(
    `INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at, resumes, model, session_id)
     VALUES ('lost-local', 'claude', 'app', '/x', 'lost', '2026-10-13T05:00:00Z', 0, 'local', ?)`,
  ).run(session);
  try {
    expect((await manager.resume("lost-local"))?.id).toBe("lost-local");
    // The fake prints once, then sits quiet: the screen holds its line.
    await manager.waitFor("lost-local", { quietMs: 300, timeoutMs: 3000 });
    const text = (await manager.read("lost-local"))?.text ?? "";
    expect(text).toContain("BASE=http://127.0.0.1:4999/api/machines/win/ai TOKEN=local");
    expect(text).toContain(`--resume ${session} --model local`);
  } finally {
    await manager.stopAll(200);
    rmSync(dir, { recursive: true, force: true });
  }
});
