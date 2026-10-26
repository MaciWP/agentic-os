import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ROOT, ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { cleanEnv } from "../terminals/env.ts";
import { TerminalManager } from "../terminals/pty.ts";

test("a managed harness receives its own identity, app URL and executable aos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-identity-"));
  const fake = join(dir, "fixture-harness");
  writeFileSync(
    fake,
    '#!/bin/sh\nprintf "AGENT=%s\\nURL=%s\\n" "$AOS_AGENT_ID" "$AOS_URL"\ncommand -v aos\naos help\n',
  );
  chmodSync(fake, 0o700);
  const db = openDb(":memory:");
  const manager = new TerminalManager(
    ConfigSchema.parse({ port: 4999, terminals: { bins: { claude: fake } } }),
    db,
    async () =>
      cleanEnv({ PATH: "/usr/bin:/bin", AOS_AGENT_ID: "parent", AOS_URL: "http://wrong" }, {}),
  );
  try {
    const t = await manager.create({ harness: "claude", location: "app", model: "fixture" });
    const end = Date.now() + 3000;
    while (manager.get(t.id)?.state === "running" && Date.now() < end) await Bun.sleep(20);
    const screen = await manager.read(t.id);
    expect(screen?.text).toContain(`AGENT=${t.id}`);
    expect(screen?.text).toContain("URL=http://localhost:4999");
    expect(screen?.text).toContain(join(APP_ROOT, "bin/aos"));
    expect(screen?.text).toContain("aos capabilities | self | coordination");
  } finally {
    await manager.stopAll(100);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
