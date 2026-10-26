import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageBody, ImageError, type ImageSource, ImageStore, saveImage, sniff } from "./store.ts";

const bytes = (...xs: (number | string)[]) =>
  Buffer.concat(xs.map((x) => (typeof x === "string" ? Buffer.from(x, "latin1") : Buffer.of(x))));
// The smallest PNG and JPEG the sniffer takes.
const png = bytes(0x89, "PNG\r\n\x1a\n", 0, 0, 0, 13);
const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0);
const WEEK = 7 * 24 * 60 * 60 * 1000;
const UUID_A = "00000000-0000-4000-8000-000000000000";
const UUID_B = "11111111-1111-4111-8111-111111111111";

describe("sniff", () => {
  test("names each format by its own bytes", () => {
    expect(sniff(png)).toBe("image/png");
    expect(sniff(jpeg)).toBe("image/jpeg");
    expect(sniff(bytes("GIF89a", 0))).toBe("image/gif");
    expect(sniff(bytes("GIF87a", 0))).toBe("image/gif");
    expect(sniff(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("image/webp");
  });

  test("anything else is not an image", () => {
    for (const b of [bytes(), bytes("<svg"), bytes("GIF80a"), bytes("RIFF", 0, 0, 0, 0, "WAVE")])
      expect(sniff(b)).toBeNull();
  });
});

describe("ImageBody", () => {
  const ok = (data: string, mime = "image/png") =>
    ImageBody.safeParse({ image: { mime, data } }).success;

  test("takes base64 of an allowed type only", () => {
    expect(ok("iVBORw==")).toBe(true);
    expect(ok("iVBORw=")).toBe(false);
    expect(ok("iVBO\nRw==")).toBe(false);
    expect(ok("iVBORw==", "image/svg+xml")).toBe(false);
    expect(ok("iVBORw==", "text/plain")).toBe(false);
  });
});

describe("saveImage", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-paste-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("drops its own files and partial writes older than a week, and nothing else", async () => {
    const old = join(dir, `${UUID_A}.png`);
    const partial = join(dir, `.${UUID_B}.tmp`);
    const recent = join(dir, `${UUID_B}.png`);
    const foreign = join(dir, "notes.png");
    for (const f of [old, partial, recent, foreign]) writeFileSync(f, "x");
    const now = Date.now();
    for (const f of [old, partial, foreign])
      utimesSync(f, new Date(now - WEEK - 1000), new Date(now - WEEK - 1000));
    const path = await saveImage(dir, png, { claimed: "image/png", now });
    expect(readFileSync(path)).toEqual(png);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect([old, partial].map(existsSync)).toEqual([false, false]);
    expect([recent, foreign].map(existsSync)).toEqual([true, true]);
    // The write went through a dot name, and nothing of it is left.
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses bytes that are not the claimed type, or not an image at all", async () => {
    await expect(saveImage(dir, png, { claimed: "image/jpeg" })).rejects.toBeInstanceOf(ImageError);
    await expect(saveImage(dir, bytes("hello"))).rejects.toBeInstanceOf(ImageError);
  });
});

describe("ImageStore", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-images-"));
  const pastes = join(root, "pastes");
  const captures = join(pastes, "captures");
  const folder = join(root, "shots");
  const outside = join(root, "outside");
  afterAll(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  let sources: ImageSource[] = [];
  const store = new ImageStore(async () => sources, pastes);
  const at = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));
  const t0 = Date.now() - 60_000;

  beforeEach(() => {
    for (const d of [pastes, folder, outside]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    sources = [
      { id: "pasted", dir: pastes, own: true },
      { id: "captured", dir: captures, own: true },
      { id: "folder", dir: folder, own: false },
    ];
  });

  test("lists the newest images of every source, each only what its source owns", async () => {
    writeFileSync(join(pastes, `${UUID_A}.png`), png);
    writeFileSync(join(pastes, "foreign.png"), png);
    writeFileSync(join(pastes, `.${UUID_B}.tmp`), png);
    const shot = "Captura de pantalla 2026-10-07 a las 10.00.00 %#.png";
    writeFileSync(join(folder, shot), png);
    writeFileSync(join(folder, "photo.JPG"), jpeg);
    writeFileSync(join(folder, ".hidden.png"), png);
    writeFileSync(join(folder, "notes.txt"), "x");
    writeFileSync(join(folder, "huge.png"), Buffer.alloc((10 << 20) + 1));
    writeFileSync(join(outside, "secret.png"), png);
    symlinkSync(join(outside, "secret.png"), join(folder, "link.png"));
    at(join(pastes, `${UUID_A}.png`), t0 + 2000);
    at(join(folder, shot), t0 + 3000);
    at(join(folder, "photo.JPG"), t0 + 1000);
    const { items, sources: states } = await store.list();
    expect(items.map((i) => i.id)).toEqual([
      `folder:${shot}`,
      `pasted:${UUID_A}.png`,
      "folder:photo.JPG",
    ]);
    expect(items[0]).toMatchObject({ source: "folder", name: shot, bytes: png.length });
    expect(states.map((s) => [s.source, s.state])).toEqual([
      ["pasted", "ok"],
      ["captured", "ok"],
      ["folder", "ok"],
    ]);
    expect((await store.list(2)).items).toHaveLength(2);
  });

  test("a folder that is missing or denied says so on its own; the pasted images stay", async () => {
    writeFileSync(join(pastes, `${UUID_A}.png`), png);
    rmSync(folder, { recursive: true });
    let listed = await store.list();
    expect(listed.items.map((i) => i.id)).toEqual([`pasted:${UUID_A}.png`]);
    expect(listed.sources[2]).toMatchObject({ source: "folder", state: "missing", dir: folder });
    mkdirSync(folder);
    chmodSync(folder, 0o000);
    try {
      listed = await store.list();
      expect(listed.items).toHaveLength(1);
      expect(listed.sources[2]).toMatchObject({ source: "folder", state: "denied" });
      expect(listed.sources[2]?.detail).toBeString();
    } finally {
      chmodSync(folder, 0o700);
    }
    // Nothing pasted yet is not an error.
    rmSync(pastes, { recursive: true });
    listed = await store.list();
    expect(listed.sources[0]).toMatchObject({ source: "pasted", state: "ok", detail: null });
  });

  test("resolves any image it owns, even one past the listed ones", async () => {
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(folder, `shot ${i}.png`), png);
      at(join(folder, `shot ${i}.png`), t0 + i * 1000);
    }
    expect((await store.list()).items.map((i) => i.id)).not.toContain("folder:shot 0.png");
    const image = await store.resolve("folder:shot 0.png");
    expect(image).toMatchObject({ path: join(folder, "shot 0.png"), mime: "image/png" });
    expect(Buffer.from(image.bytes)).toEqual(png);
  });

  test("refuses ids that name no image of a source, before reading anything", async () => {
    writeFileSync(join(outside, "secret.png"), png);
    writeFileSync(join(pastes, "foreign.png"), png);
    symlinkSync(join(outside, "secret.png"), join(folder, "link.png"));
    mkdirSync(join(folder, "dir.png"));
    for (const id of [
      "folder:../outside/secret.png",
      "folder:sub/x.png",
      "folder:..\\x.png",
      "folder:.hidden.png",
      "folder:notes.txt",
      "nope:x.png",
      ":x.png",
      "folderx.png",
      "pasted:foreign.png",
      "folder:link.png",
      "folder:dir.png",
    ]) {
      const err = await store.resolve(id).catch((e) => e);
      expect([id, err]).toEqual([id, expect.any(ImageError)]);
      expect([id, err.code]).toEqual([id, "unknown_image"]);
    }
  });

  test("an image deleted, emptied of image bytes or grown past the cap is an explicit error", async () => {
    const err = (id: string) =>
      store.resolve(id).then(
        () => null,
        (e: ImageError) => e,
      );
    expect((await err("folder:gone.png"))?.code).toBe("image_gone");
    writeFileSync(join(folder, "fake.png"), "<svg/>");
    expect((await err("folder:fake.png"))?.code).toBe("bad_image");
    writeFileSync(join(folder, "big.png"), Buffer.alloc((10 << 20) + 1));
    expect((await err("folder:big.png"))?.code).toBe("bad_image");
  });

  test("a pasted image goes into the history first", async () => {
    const { item, path } = await store.save(png, "image/png");
    expect(item).toMatchObject({ source: "pasted", id: `pasted:${item.name}` });
    expect(path).toBe(join(pastes, item.name));
    expect((await store.list()).items[0]?.id).toBe(item.id);
  });

  test("the same image pasted twice is kept once, and listed first again", async () => {
    const first = await store.save(png);
    at(first.path, t0);
    writeFileSync(join(folder, "newer.png"), jpeg);
    at(join(folder, "newer.png"), t0 + 1000);
    const again = await store.save(png, "image/png");
    expect(again.item.id).toBe(first.item.id);
    expect(readdirSync(pastes)).toEqual([first.item.name]);
    expect((await store.list()).items[0]?.id).toBe(first.item.id);
    expect((await store.save(jpeg)).item.id).not.toBe(first.item.id);
    await expect(store.save(png, "image/gif")).rejects.toBeInstanceOf(ImageError);
  });

  test("for a terminal: a pasted image is typed in place and touched, a folder one is copied", async () => {
    const own = join(pastes, `${UUID_A}.png`);
    writeFileSync(own, png);
    at(own, Date.now() - WEEK + 60_000);
    writeFileSync(join(folder, "a b.jpg"), jpeg);
    const paths = await store.forTerminal([`pasted:${UUID_A}.png`, "folder:a b.jpg"]);
    expect(paths[0]).toBe(own);
    expect(Date.now() - statSync(own).mtimeMs).toBeLessThan(60_000);
    expect(paths[1]).toMatch(new RegExp(`^${pastes}/[0-9a-f-]{36}\\.jpg$`));
    expect(readFileSync(paths[1] ?? "")).toEqual(jpeg);
    expect(existsSync(join(folder, "a b.jpg"))).toBe(true);
  });

  test("removes a pasted image only; a folder's image and a foreign name stay", async () => {
    const { item, path } = await store.save(png);
    writeFileSync(join(folder, "shot.png"), png);
    await expect(store.remove("folder:shot.png")).rejects.toMatchObject({ code: "not_pasted" });
    expect(existsSync(join(folder, "shot.png"))).toBe(true);
    await expect(store.remove("pasted:../shots/shot.png")).rejects.toMatchObject({
      code: "unknown_image",
    });
    await store.remove(item.id);
    expect(existsSync(path)).toBe(false);
    await expect(store.remove(item.id)).rejects.toMatchObject({ code: "image_gone" });
  });

  test("a capture is kept in its own folder, listed apart from the pasted images", async () => {
    const pasted = await store.save(png);
    at(pasted.path, t0);
    const shot = await store.save(jpeg, undefined, "captured");
    expect(shot.item).toMatchObject({ source: "captured", id: `captured:${shot.item.name}` });
    expect(shot.path).toBe(join(captures, shot.item.name));
    expect(shot.item.name).toEndWith(".jpg");
    // The captures folder inside the pasted one is not a pasted image.
    expect((await store.list()).items.map((i) => i.id)).toEqual([shot.item.id, pasted.item.id]);
    // The same bytes captured again are the same capture; pasted, they are a pasted image.
    expect((await store.save(jpeg, undefined, "captured")).item.id).toBe(shot.item.id);
    expect((await store.save(png, undefined, "captured")).item.id).not.toBe(pasted.item.id);
    expect(await store.forTerminal([shot.item.id])).toEqual([shot.path]);
    await store.remove(shot.item.id);
    expect(existsSync(shot.path)).toBe(false);
  });

  test("a capture with no captures folder among the sources is refused", async () => {
    sources = sources.filter((s) => s.id !== "captured");
    await expect(store.save(png, undefined, "captured")).rejects.toBeInstanceOf(ImageError);
  });

  test("for a terminal: one bad id and nothing is copied", async () => {
    writeFileSync(join(folder, "ok.png"), png);
    const before = readdirSync(pastes);
    await expect(store.forTerminal(["folder:ok.png", "folder:gone.png"])).rejects.toMatchObject({
      code: "image_gone",
    });
    expect(readdirSync(pastes)).toEqual(before);
  });
});
