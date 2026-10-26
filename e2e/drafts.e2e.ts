import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { addMesa, origin, removeTerminals, waitReady, workspaceIntent } from "./helpers.ts";

// The images in a Claude draft, as the hud mod reports them, show at full resolution on a shelf
// at the foot of the Mesa's left rail, open or folded, and over the bottom left corner of a
// popped-out window: never over a terminal. Only a running Claude session may set them, and an
// e2e run launches no real Claude, so the server's refusal of a shell is checked for real while
// the list a Claude session would cause reaches the window through its own socket and the
// bytes through a route. Only a shell in the app's folder is launched, stopped and removed.
const EVIDENCE = "data/evidence/drafts";
const headers = { origin, "content-type": "application/json" };
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SIZE = Buffer.from(PNG, "base64").length;

// Passes every frame both ways and lets the test add the server's drafts message.
async function routeDrafts(page: Page) {
  const sockets: ((m: string) => void)[] = [];
  await page.routeWebSocket(/\/api\/terminals\/[^/]+\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    sockets.push((m) => ws.send(m));
  });
  await page.route(/\/api\/terminals\/[^/]+\/drafts\/\d+/, (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") }),
  );
  return (...ns: number[]) => {
    const images = ns.map((n) => ({ n, v: n, size: SIZE }));
    for (const send of sockets) send(JSON.stringify({ type: "drafts", images }));
  };
}

test.describe("draft images", () => {
  let id = "";
  test.beforeAll(async ({ request }) => {
    mkdirSync(EVIDENCE, { recursive: true });
    const res = await request.post("/api/terminals", {
      headers,
      data: { harness: "shell", location: "app" },
    });
    expect(res.ok(), await res.text()).toBe(true);
    id = ((await res.json()) as { terminal: { id: string } }).terminal.id;
  });
  test.afterAll(async ({ request }) => removeTerminals(request, [id]));

  test("a shell is not a Claude session: the server takes no draft from it", async ({
    request,
  }) => {
    const refused = await request.post(`/api/terminals/${id}/drafts`, {
      headers: { ...headers, "x-aos-agent-id": id },
      data: { images: [{ n: 1, image: { mime: "image/png", data: PNG } }] },
    });
    expect(refused.status()).toBe(403);
  });

  test("in the Mesa they sit at the foot of the left rail, open or folded, numbered", async ({
    page,
    request,
  }) => {
    const mesa = crypto.randomUUID();
    await addMesa(request, { id: mesa, name: `Borrador ${mesa.slice(0, 6)}`, ids: [id] });
    try {
      const tell = await routeDrafts(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/terminales?mesa=${mesa}`);
      await waitReady(page.locator(`[data-terminal-id="${id}"]`));
      const rail = page.locator("#grid-picker");
      if (!(await rail.isVisible()))
        await page.getByRole("button", { name: "Mostrar el carril" }).click();

      tell(1, 2);
      const shelf = rail.getByRole("region", { name: "Imágenes del borrador" });
      await expect(shelf.getByRole("img")).toHaveCount(2);
      await expect(shelf.getByText("#2", { exact: true })).toBeVisible();
      await expect(shelf.getByText("1×1 · 1 KB").first()).toBeVisible();
      // The shelf is below the tree, inside the rail: no terminal is covered.
      const tile = await page.locator(`[data-terminal-id="${id}"]`).boundingBox();
      const box = await shelf.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(tile?.x ?? 0);
      await page.screenshot({ path: `${EVIDENCE}/rail-open-1440.png` });

      await shelf.getByRole("button", { name: "Ver la imagen 1 en grande" }).click();
      const large = page.getByRole("dialog", { name: "Imagen #1 del borrador" });
      await expect(large.getByRole("img")).toBeVisible();
      // The prompt was sent: the draft empties, and the large view goes with it.
      tell();
      await expect(large).toBeHidden();
      await expect(shelf).toBeHidden();

      await page.getByRole("button", { name: "Ocultar el carril" }).click();
      tell(1);
      const folded = page.getByRole("region", { name: "Imágenes del borrador" });
      await expect(folded.getByRole("button", { name: "Ver la imagen 1 en grande" })).toBeVisible();
      await page.screenshot({ path: `${EVIDENCE}/rail-folded-1440.png` });
      await page.getByRole("button", { name: "Mostrar el carril" }).click();
    } finally {
      await workspaceIntent(request, { kind: "close", mesa });
    }
  });

  test("a popped-out window shows them over its bottom left corner", async ({ page }) => {
    const tell = await routeDrafts(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminal/${id}`);
    await waitReady(page.locator("body"), id);
    tell(1, 2);
    const shelf = page.getByRole("region", { name: "Imágenes del borrador" });
    await expect(shelf.getByRole("img")).toHaveCount(2);
    const box = await shelf.boundingBox();
    expect(box?.x ?? 999).toBeLessThan(40);
    await page.screenshot({ path: `${EVIDENCE}/window-1280.png` });
  });
});
