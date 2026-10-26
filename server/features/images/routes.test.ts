import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { PasteMode, TerminalInfo, Terminals } from "../terminals/contract.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import type { Captured } from "./capture.ts";
import { CaptureHotkey } from "./hotkey.ts";
import { ImageError, ImageStore } from "./store.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HOST = "127.0.0.1:4317";
const ORIGIN = "http://127.0.0.1:4317";

describe("image history routes", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-image-routes-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pastes = join(root, "pastes");
  const captures = join(pastes, "captures");
  const folder = join(root, "shots");
  mkdirSync(folder, { recursive: true });
  // A macOS screenshot name: a narrow no-break space before "p. m.", plus % and #.
  const shot = "Captura de pantalla 2026-10-07 a las 10.00.00 p. m. 100% #2.png";
  writeFileSync(join(folder, shot), png);
  utimesSync(join(folder, shot), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

  const term = { id: "cl", harness: "claude", state: "running" } as TerminalInfo;
  const writes: { id: string; data: string; paste?: PasteMode }[] = [];
  const terminals = {
    subscribe: () => () => {},
    list: () => [term],
    get: (id: string) => (id === term.id ? term : undefined),
    write: (id: string, data: string, { paste }: { paste?: PasteMode } = {}) => {
      writes.push({ id, data, paste });
      return true;
    },
  } as unknown as Terminals;
  // What the next "Capturar" gets; a held promise keeps one open.
  let capture: () => Promise<Captured> = async () => ({ kind: "cancelled" });
  // ⌃⌘4's helper, never launched: its `open` waits until the test ends.
  let granted = false;
  let settings = 0;
  const hotkey = new CaptureHotkey({
    port: 4317,
    dir: join(root, "helper"),
    spawn: () => ({ exited: new Promise(() => {}) }),
    stop: async () => {},
    helper: async () => ({ granted }),
    openSettings: async () => {
      settings++;
    },
  });
  afterAll(() => hotkey.stop());
  const app = createApp({
    hotkey,
    capture: () => capture(),
    config: ConfigSchema.parse({ repos: [] }),
    db: openDb(":memory:"),
    terminals,
    tokens: new AttachTokens(),
    memoryRoots: { home: join(root, "home"), dataDir: join(root, "data"), repos: [] },
    pastesDir: pastes,
    images: new ImageStore(
      async () => [
        { id: "pasted", dir: pastes, own: true },
        { id: "captured", dir: captures, own: true },
        { id: "folder", dir: folder, own: false },
      ],
      pastes,
    ),
  });
  const get = (path: string, host = HOST) => app.request(path, { headers: { host } });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const paste = () =>
    post("/api/images", { image: { mime: "image/png", data: png.toString("base64") } });

  test("an id with a narrow space, % and # comes back through the URL as the same image", async () => {
    const list = await (await get("/api/images")).json();
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([`folder:${shot}`]);
    // No watcher given: the clipboard is not read. The helper is not started yet.
    expect(list.clipboard).toEqual({ state: "off", detail: null });
    expect(list.hotkey).toEqual({ state: "off", detail: null });
    const res = await get(`/api/images/${encodeURIComponent(`folder:${shot}`)}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "no-store",
    });
  });

  test("unknown and deleted images fail as JSON with their own status", async () => {
    const unknown = await get(`/api/images/${encodeURIComponent("folder:../pastes/x.png")}`);
    expect([unknown.status, (await unknown.json()).error]).toEqual([404, "unknown_image"]);
    const gone = await get(`/api/images/${encodeURIComponent("folder:gone.png")}`);
    expect([gone.status, (await gone.json()).error]).toEqual([410, "image_gone"]);
  });

  test("another Host reads nothing", async () => {
    expect((await get("/api/images", "evil.example:4317")).status).toBe(403);
  });

  test("a pasted image is kept and listed first; anything else is refused", async () => {
    const res = await paste();
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item).toMatchObject({ source: "pasted" });
    const list = await (await get("/api/images")).json();
    expect(list.items[0].id).toBe(item.id);
    const fake = await post("/api/images", {
      image: { mime: "image/png", data: Buffer.from("not an image").toString("base64") },
    });
    expect([fake.status, (await fake.json()).error]).toEqual([400, "bad_image"]);
    const extra = await post("/api/images", { image: { mime: "image/png", data: "QUJD" }, x: 1 });
    expect(extra.status).toBe(400);
  });

  test("a pasted image can be deleted; a folder's image cannot, nor without the guard", async () => {
    const { item } = await (await paste()).json();
    const del = (id: string, headers: Record<string, string>) =>
      app.request(`/api/images/${encodeURIComponent(id)}`, { method: "DELETE", headers });
    const json = { host: HOST, origin: ORIGIN, "content-type": "application/json" };
    expect((await del(item.id, { host: HOST, origin: "http://evil.example" })).status).toBe(403);
    const folderOne = await del(`folder:${shot}`, json);
    expect([folderOne.status, (await folderOne.json()).error]).toEqual([409, "not_pasted"]);
    expect(await (await del(item.id, json)).json()).toEqual({ removed: true });
    const ids = (await (await get("/api/images")).json()).items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(item.id);
    expect(ids).toContain(`folder:${shot}`);
  });

  test("a paste is refused before it is kept: wrong type, bad base64, a path, too large", async () => {
    const before = (await (await get("/api/images")).json()).items.length;
    const data = png.toString("base64");
    const cases: [unknown, number, string][] = [
      [{ image: { mime: "image/jpeg", data } }, 400, "bad_image"],
      [{ image: { mime: "image/png", data: "%%%%" } }, 400, "bad_request"],
      [{ image: { mime: "image/svg+xml", data } }, 400, "bad_request"],
      [{ image: { mime: "image/png", data, path: "/etc/passwd" } }, 400, "bad_request"],
      [{ image: { mime: "image/png", data: "A".repeat(15 << 20) } }, 413, "too_large"],
    ];
    for (const [body, status, error] of cases) {
      const res = await post("/api/images", body);
      expect([error, res.status]).toEqual([error, status]);
      expect(await res.json()).toMatchObject({ error });
    }
    expect((await (await get("/api/images")).json()).items).toHaveLength(before);
  });

  test("a capture is kept with the captures; a cancel or the clipboard route keep nothing", async () => {
    capture = async () => ({ kind: "image", bytes: new Uint8Array([...png, 7]) });
    const res = await post("/api/images/capture", {});
    const { item } = await res.json();
    expect(item).toMatchObject({ source: "captured" });
    expect((await (await get("/api/images")).json()).items[0].id).toBe(item.id);
    capture = async () => ({ kind: "cancelled" });
    expect(await (await post("/api/images/capture", {})).json()).toEqual({ cancelled: true });
    capture = async () => ({ kind: "clipboard" });
    expect(await (await post("/api/images/capture", {})).json()).toEqual({ clipboard: true });
  });

  test("a capture the browser took itself goes with the captures", async () => {
    const data = Buffer.from([...png, 8]).toString("base64");
    const res = await post("/api/images", {
      source: "captured",
      image: { mime: "image/png", data },
    });
    expect((await res.json()).item).toMatchObject({ source: "captured" });
    const other = await post("/api/images", {
      source: "folder",
      image: { mime: "image/png", data },
    });
    expect(other.status).toBe(400);
  });

  test("one capture at a time", async () => {
    let finish = () => {};
    capture = () =>
      new Promise((resolve) => {
        finish = () => resolve({ kind: "cancelled" });
      });
    const first = post("/api/images/capture", {});
    await Bun.sleep(10);
    const second = await post("/api/images/capture", {});
    expect([second.status, (await second.json()).error]).toEqual([409, "capture_busy"]);
    finish();
    expect((await first).status).toBe(200);
    capture = async () => ({ kind: "cancelled" });
    expect((await post("/api/images/capture", {})).status).toBe(200);
  });

  test("a failed capture says why and frees the next one", async () => {
    capture = async () => {
      throw new ImageError("screencapture failed (1): no display", "capture_failed");
    };
    const failed = await post("/api/images/capture", {});
    expect([failed.status, (await failed.json()).error]).toEqual([500, "capture_failed"]);
    capture = async () => ({ kind: "cancelled" });
    expect((await post("/api/images/capture", {})).status).toBe(200);
  });

  test("bring images: every path on one line, without Enter", async () => {
    writes.length = 0;
    const { item } = await (await paste()).json();
    const shotBody = { image: { mime: "image/png", data: png.toString("base64") } };
    const { item: captured } = await (
      await post("/api/images", { ...shotBody, source: "captured" })
    ).json();
    expect(captured.id).toStartWith("captured:");
    const res = await post("/api/terminals/cl/bring", {
      images: [item.id, `folder:${shot}`, captured.id],
    });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    const [first, second, third] = (writes[0]?.data ?? "").split(" ");
    expect(writes[0]?.paste).toBe(true);
    expect(first).toBe(join(pastes, item.name));
    // The screenshot is copied under a plain name the app owns.
    expect(second).toMatch(new RegExp(`^${pastes}/[0-9a-f-]{36}\\.png$`));
    expect(readFileSync(second ?? "")).toEqual(png);
    expect(third).toBe(join(captures, captured.name));
  });

  test("bring images: one bad id, or too many, and nothing is typed", async () => {
    writes.length = 0;
    const bad = await post("/api/terminals/cl/bring", {
      images: [`folder:${shot}`, "folder:gone.png"],
    });
    expect([bad.status, (await bad.json()).error]).toEqual([410, "image_gone"]);
    const many = await post("/api/terminals/cl/bring", { images: Array(6).fill(`folder:${shot}`) });
    expect(many.status).toBe(400);
    const none = await post("/api/terminals/cl/bring", { images: [] });
    expect(none.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  describe("⌃⌘4", () => {
    const UUID = "00000000-0000-4000-8000-00000000000a";
    const leave = (name: string, bytes: Buffer) => writeFileSync(join(hotkey.dir, name), bytes);
    const target = (terminal: string | null, label?: string) =>
      post("/api/images/target", { terminal, label });
    const shoot = async (file: string) => {
      const res = await post("/api/images/hotkey/shot", { file });
      return { status: res.status, body: await res.json() };
    };

    test("only the helper this server started says its state", async () => {
      const report = (body: unknown) => post("/api/images/hotkey/state", body);
      expect((await report({ state: "ready", pid: 77 })).status).toBe(409);
      hotkey.start();
      await Bun.sleep(5);
      expect(await (await report({ state: "ready", pid: 77 })).json()).toEqual({ accepted: true });
      expect((await (await get("/api/images")).json()).hotkey).toEqual({
        state: "ready",
        detail: null,
      });
      expect((await report({ state: "ready", pid: 78 })).status).toBe(409);
      expect((await report({ state: "off", pid: 77 })).status).toBe(400);
      expect((await report({ state: "ready", pid: 77, path: "/x" })).status).toBe(400);
    });

    test("a capture is kept, taken out of the helper's folder and typed where the focus was", async () => {
      writes.length = 0;
      await post("/api/images/hotkey/state", { state: "capturing", pid: 77 });
      expect((await target("cl", "Claude · agentic-os")).status).toBe(200);
      leave(`${UUID}.png`, Buffer.from([...png, 9]));
      const { status, body } = await shoot(`${UUID}.png`);
      expect(status).toBe(200);
      expect(body.item).toMatchObject({ source: "captured" });
      expect(body.text).toBe("Captura pegada en Claude · agentic-os");
      expect(writes).toEqual([{ id: "cl", data: join(captures, body.item.name), paste: true }]);
      expect(readdirSync(hotkey.dir)).toEqual([]);
      expect((await (await get("/api/images")).json()).hotkey.state).toBe("ready");
    });

    test("with no terminal focused, or one gone, the capture stays in the history only", async () => {
      writes.length = 0;
      for (const [terminal, n] of [
        [null, 10],
        ["gone", 11],
      ] as const) {
        await target(terminal);
        leave(`${UUID}.png`, Buffer.from([...png, n]));
        const { body } = await shoot(`${UUID}.png`);
        expect(body.text).toBe("Guardada en el historial: no hay terminal activa");
        const ids = (await (await get("/api/images")).json()).items.map(
          (i: { id: string }) => i.id,
        );
        expect(ids).toContain(body.item.id);
      }
      expect(writes).toEqual([]);
    });

    test("a shot names a file the helper left, nothing else, and is removed even when refused", async () => {
      for (const file of ["../x.png", "/etc/passwd", "x.png", `${UUID}.jpg`, `${UUID}.PNG`])
        expect([file, (await shoot(file)).status]).toEqual([file, 400]);
      expect((await shoot(`${UUID}.png`)).body.error).toBe("image_gone");
      writeFileSync(join(root, "outside.png"), png);
      symlinkSync(join(root, "outside.png"), join(hotkey.dir, `${UUID}.png`));
      expect((await shoot(`${UUID}.png`)).body.error).toBe("unknown_image");
      expect(existsSync(join(hotkey.dir, `${UUID}.png`))).toBe(false);
      expect(existsSync(join(root, "outside.png"))).toBe(true);
      leave(`${UUID}.png`, Buffer.from("not an image"));
      expect((await shoot(`${UUID}.png`)).body.error).toBe("bad_image");
      expect(readdirSync(hotkey.dir)).toEqual([]);
    });

    test("a focus report is a terminal id and a short name, or none", async () => {
      expect((await target("cl", "x".repeat(81))).status).toBe(400);
      expect((await post("/api/images/target", { terminal: "/etc", extra: 1 })).status).toBe(400);
      expect(await (await target(null)).json()).toEqual({ target: null });
    });

    test("a refused grant leads to System Settings", async () => {
      granted = false;
      expect(await (await post("/api/images/capture/grant", {})).json()).toEqual({
        granted: false,
      });
      expect(settings).toBe(1);
    });
  });
});
