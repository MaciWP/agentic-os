import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { until } from "../../test-wait.ts";
import { NameBody, type TerminalInfo, type Terminals } from "./contract.ts";
import { cleanEnv } from "./env.ts";
import { TerminalManager } from "./pty.ts";
import { AttachTokens } from "./ws-guard.ts";

describe("terminal name", () => {
  test("trimmed, at most 40 characters, empty clears it, no control or format characters", () => {
    const parse = (name: unknown) => NameBody.safeParse({ name });
    expect(parse("  api  ").data?.name).toBe("api");
    expect(parse("").data?.name).toBeNull();
    expect(parse("   ").data?.name).toBeNull();
    expect(parse(null).data?.name).toBeNull();
    expect(parse("x".repeat(40)).success).toBe(true);
    expect(parse("Pruebas de categoría").data?.name).toBe("Pruebas de categoría");
    expect(parse("x".repeat(41)).success).toBe(false);
    expect(parse("a\u0007b").success).toBe(false);
    expect(parse("a\nb").success).toBe(false);
    // A bidi override would make one name read as another.
    expect(parse("api\u202Egnp.").success).toBe(false);
    expect(parse("a\u200Bb").success).toBe(false);
    expect(parse(7).success).toBe(false);
    expect(NameBody.safeParse({}).success).toBe(false);
  });
});

describe("rename and open a terminal's folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-name-"));
  const log = join(dir, "editor.log");
  const editor = join(dir, "editor");
  writeFileSync(editor, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n`);
  chmodSync(editor, 0o755);
  const env = Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {}));
  const make = (terminals: Record<string, unknown>) => {
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh", ...terminals } });
    const db = openDb(":memory:");
    const manager = new TerminalManager(config, db, () => env);
    const app = createApp({
      config,
      db,
      terminals: manager,
      tokens: new AttachTokens(),
      memoryRoots: { home: join(dir, "home"), dataDir: join(dir, "data"), repos: [] },
    });
    return { manager, app };
  };
  const withEditor = make({ editor });
  const without = make({});
  afterAll(async () => {
    await withEditor.manager.stopAll(200);
    await without.manager.stopAll(200);
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (
    app: ReturnType<typeof make>["app"],
    path: string,
    body: unknown = {},
    origin = "http://127.0.0.1:4317",
  ) =>
    app.request(path, {
      method: "POST",
      headers: { host: "127.0.0.1:4317", origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("the host keeps the name, announces a change once, and an ended terminal keeps it", async () => {
    const { manager } = without;
    const t = await manager.create({ harness: "shell", location: "app" });
    let events = 0;
    const off = manager.subscribe(() => events++);
    expect(manager.rename("nope", "x")).toBe(false);
    expect(manager.rename(t.id, "api")).toBe(true);
    expect(manager.get(t.id)?.name).toBe("api");
    expect(manager.list().find((x) => x.id === t.id)?.name).toBe("api");
    expect(events).toBe(1);
    // The same name again is not a change.
    expect(manager.rename(t.id, "api")).toBe(true);
    expect(events).toBe(1);
    manager.stop(t.id);
    await until(() => manager.get(t.id)?.state !== "running");
    off();
    expect(manager.get(t.id)?.name).toBe("api");
    expect(manager.rename(t.id, null)).toBe(true);
    expect(manager.get(t.id)?.name).toBeNull();
  });

  test("POST /name sets and clears it behind the local guard", async () => {
    const { manager, app } = without;
    const t = await manager.create({ harness: "shell", location: "app" });
    const res = await post(app, `/api/terminals/${t.id}/name`, { name: "  frontend  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "frontend" });
    expect(manager.get(t.id)?.name).toBe("frontend");
    const listed = (await (
      await app.request("/api/terminals", { headers: { host: "127.0.0.1:4317" } })
    ).json()) as { terminals: { id: string; name: string | null }[]; openFolder: boolean };
    expect(listed.terminals.find((x) => x.id === t.id)?.name).toBe("frontend");
    expect(listed.openFolder).toBe(false);
    expect((await post(app, `/api/terminals/${t.id}/name`, { name: "x".repeat(41) })).status).toBe(
      400,
    );
    expect((await post(app, `/api/terminals/${t.id}/name`, { name: "a\u202Eb" })).status).toBe(400);
    expect((await post(app, "/api/terminals/nope/name", { name: "x" })).status).toBe(404);
    expect(
      (await post(app, `/api/terminals/${t.id}/name`, { name: "x" }, "http://evil.test")).status,
    ).toBe(403);
    expect(manager.get(t.id)?.name).toBe("frontend");
    expect((await post(app, `/api/terminals/${t.id}/name`, { name: "" })).status).toBe(200);
    expect(manager.get(t.id)?.name).toBeNull();
    manager.stop(t.id);
  });

  test("open-folder runs [editor, cwd] with the server's path, or says why it cannot", async () => {
    const t = await withEditor.manager.create({ harness: "shell", location: "app" });
    const res = await post(withEditor.app, `/api/terminals/${t.id}/open-folder`, {
      path: "/etc",
    });
    expect(res.status).toBe(200);
    await until(() => existsSync(log) && readFileSync(log, "utf8").length > 0);
    // Exactly one argument, the terminal's own cwd; the body's path is ignored.
    expect(readFileSync(log, "utf8")).toBe(`${t.cwd}\n`);
    expect((await post(withEditor.app, "/api/terminals/nope/open-folder")).status).toBe(404);
    expect(
      (await post(withEditor.app, `/api/terminals/${t.id}/open-folder`, {}, "http://evil.test"))
        .status,
    ).toBe(403);
    withEditor.manager.stop(t.id);

    const u = await without.manager.create({ harness: "shell", location: "app" });
    const refused = await post(without.app, `/api/terminals/${u.id}/open-folder`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "editor_not_configured" });
    without.manager.stop(u.id);
  });

  test("a folder that is gone is a 409 and the editor never runs", async () => {
    const gone = join(dir, "gone");
    mkdirSync(gone);
    const t = await withEditor.manager.create({ harness: "shell", location: "app" });
    const info = { ...withEditor.manager.get(t.id), cwd: gone } as TerminalInfo;
    withEditor.manager.stop(t.id);
    rmSync(gone, { recursive: true });
    writeFileSync(log, "");
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh", editor } });
    const terminals = {
      subscribe: () => () => {},
      list: () => [info],
      get: (id: string) => (id === info.id ? info : undefined),
      env: env,
    } as unknown as Terminals;
    const app = createApp({
      config,
      db: openDb(":memory:"),
      terminals,
      tokens: new AttachTokens(),
      memoryRoots: { home: join(dir, "home"), dataDir: join(dir, "data"), repos: [] },
    });
    const res = await post(app, `/api/terminals/${info.id}/open-folder`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "folder_gone" });
    await Bun.sleep(200);
    expect(readFileSync(log, "utf8")).toBe("");
  });
});
