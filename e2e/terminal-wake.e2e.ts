import { expect, type Page, test } from "@playwright/test";
import { origin, removeTerminals, typeIn } from "./helpers.ts";

// Coming back to the page (another tab, another desktop, a minimized window) keeps a healthy
// terminal as it was: same socket, same scroll. Only a socket that no longer answers is
// replaced. The window asks with a ping and waits PROBE_MS for any frame.
const PROBE_MS = 4_000;

// Hidden, then shown, as the browser says it.
const hideAndShow = (page: Page) =>
  page.evaluate(() => {
    for (const state of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });

const firstRow = async (page: Page) =>
  (await page.locator(".xterm-rows").innerText()).split("\n")[0];

async function shell(page: Page) {
  const res = await page.request.post("/api/terminals", {
    headers: { origin, "content-type": "application/json" },
    data: { harness: "shell", location: "app" },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { terminal: { id: string } }).terminal.id;
}

// The socket goes through Playwright, which can stop passing the server's frames: the path is
// dead while the socket still reads as open, as after a phone sleeps or a network drops.
async function routeSockets(page: Page) {
  const sockets: { dead: boolean }[] = [];
  await page.routeWebSocket(/\/api\/terminals\/[^/]+\/ws$/, (ws) => {
    const socket = { dead: false };
    sockets.push(socket);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (!socket.dead) ws.send(m);
    });
  });
  return {
    opened: () => sockets.length,
    kill: () => {
      for (const s of sockets) s.dead = true;
    },
  };
}

test("coming back to the page keeps a healthy terminal's socket and scroll", async ({ page }) => {
  const sockets = await routeSockets(page);
  const id = await shell(page);
  try {
    await page.goto(`/terminal/${id}`);
    await typeIn(page.locator("body"), "for i in $(seq 1 300); do echo line$i; done", id);
    await expect(page.locator(".xterm-rows")).toContainText("line300");
    const box = await page.locator(".xterm-screen").boundingBox();
    await page.mouse.move((box?.x ?? 0) + 50, (box?.y ?? 0) + 50);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
    await expect.poll(() => firstRow(page)).not.toMatch(/line(2[5-9]\d|300)/);
    const before = await firstRow(page);
    const opened = sockets.opened();

    await hideAndShow(page);
    // Past the probe: a reconnect, had there been one, has happened by now.
    await page.waitForTimeout(PROBE_MS + 1_000);
    expect(sockets.opened()).toBe(opened);
    expect(await firstRow(page)).toBe(before);
    await expect(page.getByText("en marcha")).toBeVisible();
  } finally {
    await removeTerminals(page.request, [id]);
  }
});

test("coming back to a socket that no longer answers reconnects it", async ({ page }) => {
  const sockets = await routeSockets(page);
  const id = await shell(page);
  try {
    await page.goto(`/terminal/${id}`);
    await typeIn(page.locator("body"), "echo before_$((6*7))", id);
    await expect(page.locator(".xterm-rows")).toContainText("before_42");
    const opened = sockets.opened();

    sockets.kill();
    await hideAndShow(page);
    await expect.poll(() => sockets.opened(), { timeout: PROBE_MS + 10_000 }).toBe(opened + 1);
    await expect(page.getByText("en marcha")).toBeVisible();
    // The new socket carries keys again.
    await typeIn(page.locator("body"), "echo after_$((6*7))", id);
    await expect(page.locator(".xterm-rows")).toContainText("after_42");
  } finally {
    await removeTerminals(page.request, [id]);
  }
});
