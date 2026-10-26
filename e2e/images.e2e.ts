import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { origin, removeTerminals, waitReady } from "./helpers.ts";

// Images into a terminal: Cmd+V and files dropped from the system are typed at once; the
// history opens by its button and by Cmd/Ctrl+Shift+V, is filled by pasted images and the
// screenshots folder, shows one large, deletes a pasted one, and is emptied into a terminal by
// Enter or by a drag. Only the isolated server runs it: it seeds a screenshots folder of its
// own (AOS_E2E_SHOTS), never the user's. Only shells in the app's folder are launched, stopped
// and removed again.
const SHOTS = process.env.AOS_E2E_SHOTS;
const EVIDENCE = "data/evidence/images";
const headers = { origin, "content-type": "application/json" };

// Real 1x1 PNGs, each its own bytes, so the history keeps every one.
const PNG = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
];
// A macOS screenshot name: a narrow no-break space, plus % and #, which a URL must carry.
const SHOT = "Captura de pantalla 2026-10-07 a las 10.00.00 100% #1.png";

// A thumbnail dragged with real pointer events, the way a hand moves it, dropped at `down` of
// the target's height.
async function dragOnto(page: Page, from: Locator, to: Locator, down = 0.5) {
  // The oldest thumbnails sit below the grid's scroll; a hand scrolls to them first.
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  if (!a) throw new Error("no thumbnail");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
  const b = await to.boundingBox();
  if (!b) throw new Error("no terminal");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * down, { steps: 8 });
  await page.mouse.up();
}

// A paste as the browser hands it to the page: the clipboard's items, on xterm's textarea.
async function paste(scope: Locator, item: { png: string[] } | { text: string }) {
  await scope.locator(".xterm-helper-textarea").evaluate((el, item) => {
    const data = new DataTransfer();
    if ("png" in item) {
      for (const png of item.png) {
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], "image.png", { type: "image/png" }));
      }
    } else data.setData("text/plain", item.text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, item);
}

// Files dragged in from the system (Finder) and dropped on the middle of `target`, as the
// browser fires it: after the enter, the rest goes to whatever is under the pointer then (an
// overlay the enter showed included). True when the page took the drop, so the browser does
// not open the file in its place.
async function dropFiles(target: Locator, files: { name: string; type: string; b64: string }[]) {
  return target.evaluate(async (el, files) => {
    const data = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      data.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const box = el.getBoundingClientRect();
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    const fire = (on: Element, type: string) =>
      !on.dispatchEvent(
        new DragEvent(type, { ...at, dataTransfer: data, bubbles: true, cancelable: true }),
      );
    fire(el, "dragenter");
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const under = document.elementFromPoint(at.clientX, at.clientY) ?? el;
    fire(under, "dragover");
    return fire(under, "drop");
  }, files);
}

// Bytes of this run only: the e2e data dir keeps earlier runs' pastes, and the same bytes are
// kept once.
const fresh = (n: number, tag: string) =>
  Buffer.concat([
    Buffer.from(PNG[n] ?? "", "base64"),
    Buffer.from(`${tag} ${Date.now()}`),
  ]).toString("base64");

// The shell's line is cleared, so each test starts from an empty prompt.
async function clearLine(page: Page, scope: Locator) {
  await scope.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+U");
}

test.describe("image history", () => {
  test.skip(!SHOTS, "only the isolated server has a screenshots folder of its own");
  const ids: string[] = [];
  const brought: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const res = await request.post("/api/terminals", {
        headers,
        data: { harness: "shell", location: "app" },
      });
      expect(res.ok()).toBe(true);
      ids.push(((await res.json()) as { terminal: { id: string } }).terminal.id);
    }
    const shots = SHOTS ?? "";
    rmSync(shots, { recursive: true, force: true });
    mkdirSync(shots, { recursive: true });
    const now = Date.now() / 1000;
    writeFileSync(join(shots, SHOT), Buffer.from(PNG[0] ?? "", "base64"));
    writeFileSync(join(shots, "segunda.png"), Buffer.from(PNG[1] ?? "", "base64"));
    utimesSync(join(shots, SHOT), now + 60, now + 60);
  });

  test.afterAll(async ({ request }) => {
    await removeTerminals(request, ids);
    rmSync(SHOTS ?? "", { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    brought.length = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/bring")) brought.push(r.url());
    });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("the button opens it; a mark and Enter type the path, which does not run", async ({
    page,
  }) => {
    await page.goto(`/terminal/${ids[0]}`);
    const view = page.locator("body");
    await waitReady(view, ids[0]);
    await page.getByRole("button", { name: "Imágenes recientes" }).click();
    const panel = page.getByRole("dialog", { name: "Imágenes recientes" });
    await expect(panel).toBeVisible();
    const shot = panel.getByRole("button", { name: /Captura de pantalla/ });
    // Loaded through its id in the URL, % and # and the narrow space included.
    await expect(shot.locator("img")).toHaveJSProperty("naturalWidth", 1);
    await expect(panel.getByRole("button", { name: /segunda\.png/ })).toBeVisible();
    mkdirSync(EVIDENCE, { recursive: true });
    await shot.click();
    await expect(shot).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `${EVIDENCE}/marked.png` });
    await page.keyboard.press("Enter");
    await expect(panel).toBeHidden();
    const rows = view.locator(".xterm-rows");
    await expect(rows).toContainText(/pastes\/[0-9a-f-]{36}\.png/);
    // Back in the terminal, and not run: the shell would say it cannot execute it.
    await expect(view.locator(".xterm-helper-textarea")).toBeFocused();
    await page.waitForTimeout(800);
    await expect(rows).not.toContainText(/permission denied|not found/);
    expect(brought).toHaveLength(1);
    await clearLine(page, view);
  });

  test("Cmd/Ctrl+Shift+V opens it and types nothing; a pasted image is typed at once", async ({
    page,
    request,
  }) => {
    await page.goto(`/terminal/${ids[0]}`);
    const view = page.locator("body");
    await waitReady(view, ids[0]);
    const rows = view.locator(".xterm-rows");
    await view.locator(".xterm-helper-textarea").focus();
    const before = await rows.innerText();
    await page.keyboard.press("ControlOrMeta+Shift+V");
    const panel = page.getByRole("dialog", { name: "Imágenes recientes" });
    await expect(panel).toBeVisible();
    await page.waitForTimeout(300);
    expect(await rows.innerText()).toBe(before);
    // Esc inside the panel closes it; the terminal has its focus back.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(view.locator(".xterm-helper-textarea")).toBeFocused();

    // Pastes kept since `since`: the list holds the newest 30, so older runs do not count.
    const pasted = async (since: number) =>
      (
        (await (await request.get("/api/images")).json()) as {
          items: { source: string; mtime: number }[];
        }
      ).items.filter((i) => i.source === "pasted" && i.mtime >= since).length;
    const png = fresh(2, "run");
    const since = Date.now();
    await paste(view, { png: [png] });
    // Typed without Enter, and the panel stays shut; a status says so and leads to it.
    await expect(rows).toContainText(/pastes\/[0-9a-f-]{36}\.png/);
    const status = view.getByRole("status").filter({ hasText: "Imagen pegada" });
    await expect(status).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(view.locator(".xterm-helper-textarea")).toBeFocused();
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE}/pasted.png` });
    // The status goes after a few seconds: its way to the history is taken first.
    await status.getByRole("button", { name: "Ver en el historial" }).click();
    expect(brought).toHaveLength(1);
    await expect.poll(() => pasted(since)).toBe(1);
    const marked = panel.getByRole("button", { pressed: true }).and(panel.locator("[data-thumb]"));
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveAccessibleName(/^Pegada/);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await clearLine(page, view);

    // Two Cmd+V in a row both land, in order; the same image is kept once.
    await paste(view, { png: [png] });
    await paste(view, { png: [png] });
    await expect.poll(() => brought.length).toBe(3);
    await expect
      .poll(async () => (await rows.innerText()).match(/pastes\/[0-9a-f-]{36}\.png/g)?.length)
      .toBe(2);
    expect(await pasted(since)).toBe(1);
    await clearLine(page, view);

    // Several images in one paste: one line, one path each.
    await paste(view, { png: [fresh(0, "multi"), fresh(1, "multi")] });
    await expect(view.getByRole("status").filter({ hasText: "2 imágenes pegadas" })).toBeVisible();
    await expect(rows).toContainText(/pastes\/[0-9a-f-]{36}\.png \S*pastes\/[0-9a-f-]{36}\.png/);
    expect(brought).toHaveLength(4);
    await clearLine(page, view);

    // A text paste still goes straight to the shell.
    await paste(view, { text: "echo texto-pegado" });
    await expect(rows).toContainText("echo texto-pegado");
    await expect(panel).toBeHidden();
    await clearLine(page, view);
  });

  test("an image file dropped from the system is typed; other files are refused, and nothing opens", async ({
    page,
  }) => {
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(2);
    await waitReady(tiles.nth(1));
    const screen = tiles.nth(1).locator("[data-terminal-screen]");
    const image = { name: "diagrama.png", type: "image/png", b64: fresh(1, "drop") };
    expect(await dropFiles(screen, [image])).toBe(true);
    await expect(tiles.nth(1).locator(".xterm-rows")).toContainText(/pastes\/[0-9a-f-]{36}\.png/);
    expect(brought).toEqual([expect.stringContaining(`/api/terminals/${ids[1]}/bring`)]);
    await clearLine(page, tiles.nth(1));
    const pdf = { name: "informe.pdf", type: "application/pdf", b64: btoa("%PDF-1.4") };
    expect(await dropFiles(screen, [pdf])).toBe(true);
    await expect(tiles.nth(1).getByRole("alert")).toContainText(
      "Solo se pegan imágenes PNG, JPEG, GIF o WebP.",
    );
    expect(brought).toHaveLength(1);
    // Dropped where nothing takes files, the page keeps it from replacing the app.
    expect(await dropFiles(page.locator("header").first(), [image])).toBe(true);
    await expect(page).toHaveURL(/\/terminales/);
    expect(brought).toHaveLength(1);
  });

  test("the history shows an image large and deletes a pasted one; a folder's stays", async ({
    page,
    request,
  }) => {
    const res = await request.post("/api/images", {
      headers,
      data: { image: { mime: "image/png", data: fresh(0, "delete") } },
    });
    const { item } = (await res.json()) as { item: { id: string; name: string } };
    await page.goto(`/terminal/${ids[0]}`);
    const view = page.locator("body");
    await waitReady(view, ids[0]);
    await page.getByRole("button", { name: "Imágenes recientes" }).click();
    const panel = page.getByRole("dialog", { name: "Imágenes recientes" });
    const thumb = panel.locator(`[data-thumb="${item.id}"]`);
    await thumb.focus();
    await page.keyboard.press("p");
    const preview = panel.getByRole("group", { name: `Vista previa: ${item.name}` });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("1×1");
    await page.screenshot({ path: `${EVIDENCE}/preview.png` });
    // Esc goes back to the grid, not out of the panel, and the keys go on from the image.
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(thumb).toBeFocused();
    // A folder's image is the user's: it is not deleted.
    const shot = panel.getByRole("button", { name: /Captura de pantalla/ });
    await shot.focus();
    await page.keyboard.press("Delete");
    await expect(panel.getByRole("alert")).toContainText("Solo se borran las imágenes pegadas");
    // A pasted one goes on the second press.
    await thumb.focus();
    await page.keyboard.press("Delete");
    await expect(thumb).toContainText("Pulsa otra vez para borrar");
    await page.keyboard.press("Delete");
    await expect(thumb).toHaveCount(0);
    const list = (await (await request.get("/api/images")).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).not.toContain(item.id);
    await expect(shot).toBeVisible();
  });

  test("a thumbnail dragged onto the terminal types its path and the panel stays", async ({
    page,
  }) => {
    await page.goto(`/terminal/${ids[0]}`);
    const view = page.locator("body");
    await waitReady(view, ids[0]);
    await page.getByRole("button", { name: "Imágenes recientes" }).click();
    const panel = page.getByRole("dialog", { name: "Imágenes recientes" });
    await dragOnto(
      page,
      panel.getByRole("button", { name: /segunda\.png/ }),
      view.locator("[data-terminal-screen]"),
      // Below the panel, which hangs over the screen's upper right and reaches its middle.
      0.85,
    );
    await expect(view.locator(".xterm-rows")).toContainText(/pastes\/[0-9a-f-]{36}\.png/);
    await expect(panel).toBeVisible();
    expect(brought).toHaveLength(1);
    await clearLine(page, view);
  });

  test("in the Mesa a thumbnail goes to the tile it is dropped on, which stays put", async ({
    page,
  }) => {
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(2);
    await waitReady(tiles.nth(1));
    const first = await tiles.nth(0).getAttribute("data-terminal-id");
    await tiles.nth(0).getByRole("button", { name: "Imágenes recientes" }).click();
    const panel = page.getByRole("dialog", { name: "Imágenes recientes" });
    await expect(panel).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/mesa.png` });
    await dragOnto(page, panel.getByRole("button", { name: /segunda\.png/ }), tiles.nth(1));
    await expect(tiles.nth(1).locator(".xterm-rows")).toContainText(/pastes\/[0-9a-f-]{36}\.png/);
    expect(brought).toEqual([expect.stringContaining(`/api/terminals/${ids[1]}/bring`)]);
    // The drag carried an image, not the tile it started from.
    expect(await tiles.nth(0).getAttribute("data-terminal-id")).toBe(first);
    await expect(panel).toBeVisible();
    await clearLine(page, tiles.nth(1));
  });

  test("outside a terminal the header's history opens by key or by a pasted image, and only drags", async ({
    page,
  }) => {
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(2);
    await waitReady(tiles.nth(1));
    const away = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await away();
    await page.keyboard.press("ControlOrMeta+Shift+V");
    const panel = page.getByRole("dialog", { name: "Imágenes recientes" });
    await expect(panel).toHaveAttribute("data-picker", "app");
    await expect(panel.getByRole("button", { name: /^Pegar/ })).toHaveCount(0);
    // The panel hangs from the header's right end over the top of the right tile: its lower
    // part still takes the drop.
    await expect(panel).toBeVisible();
    await dragOnto(page, panel.getByRole("button", { name: /segunda\.png/ }), tiles.nth(1), 0.85);
    await expect(tiles.nth(1).locator(".xterm-rows")).toContainText(/pastes\/[0-9a-f-]{36}\.png/);
    expect(brought).toEqual([expect.stringContaining(`/api/terminals/${ids[1]}/bring`)]);
    await expect(panel).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/app.png` });
    await panel.getByRole("button", { name: "Cerrar" }).click();
    await expect(panel).toBeHidden();
    await clearLine(page, tiles.nth(1));

    // In a text field the keys keep their own meaning.
    await page.getByRole("button", { name: "Buscar" }).click();
    const search = page.getByRole("combobox");
    await expect(search).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Shift+V");
    await page.waitForTimeout(300);
    await expect(panel).toHaveCount(0);
    await page.keyboard.press("Escape");

    // An image pasted on the page is kept and comes marked in the same history.
    await away();
    await page.locator("body").evaluate(
      (el, png) => {
        const data = new DataTransfer();
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], "image.png", { type: "image/png" }));
        el.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      fresh(0, "app"),
    );
    await expect(panel).toHaveAttribute("data-picker", "app");
    const marked = panel.getByRole("button", { pressed: true }).and(panel.locator("[data-thumb]"));
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveAccessibleName(/^Pegada/);
    await panel.getByRole("button", { name: "Cerrar" }).click();
    await expect(panel).toBeHidden();
  });
});
