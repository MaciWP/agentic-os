import { expect, test } from "@playwright/test";
import { addMesa, origin, READY_MS, removeTerminals, resetWorkspace } from "./helpers.ts";

// The terminal on the GPU renderer, the app's default with a hardware GPU. Headless Chromium
// emulates WebGL on the CPU unless these flags give it the Mac's GPU (Metal); the other tests
// draw with the DOM renderer (playwright.config.ts) to read its rows.
test.use({
  storageState: { cookies: [], origins: [] },
  launchOptions: { args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"] },
});

test("draws the terminal on a canvas and keeps it after output", async ({ page }) => {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("WebGL")) warnings.push(m.text());
  });
  const res = await api("/api/terminals", "POST", { harness: "shell", location: "app" });
  expect(res.ok()).toBe(true);
  const { terminal } = (await res.json()) as { terminal: { id: string } };
  const screenText = async () =>
    ((await (await api(`/api/terminals/${terminal.id}/text`, "GET")).json()) as { text: string })
      .text;
  try {
    await page.goto(`/terminal/${terminal.id}`);
    await expect(page.getByText("en marcha")).toBeVisible();
    const screen = page.locator(".xterm-screen");
    await expect(screen.locator("canvas").first()).toBeVisible();
    await expect(page.locator(".xterm-rows")).toHaveCount(0);
    await expect.poll(screenText, { timeout: READY_MS }).toMatch(/\S/);
    const before = await screen.screenshot();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo $((6*7))gpu");
    await page.keyboard.press("Enter");
    await expect.poll(screenText).toContain("42gpu");
    // What the shell printed reached the canvas, which still draws after the output.
    await expect.poll(async () => (await screen.screenshot()).equals(before)).toBe(false);
    await expect(page.locator(".xterm-rows")).toHaveCount(0);
    expect(warnings).toEqual([]);
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
});

test("the system panel moves the Mesa's terminals to the CPU and back, without a reload", async ({
  page,
  request,
}) => {
  await resetWorkspace(request);
  const res = await request.post("/api/terminals", {
    headers: { origin, "content-type": "application/json" },
    data: { harness: "shell", location: "app" },
  });
  expect(res.ok()).toBe(true);
  const { terminal } = (await res.json()) as { terminal: { id: string } };
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${terminal.id}`);
    const screen = page.locator("section[aria-label^='Shell en '] .xterm-screen");
    await expect(screen.locator("canvas").first()).toBeVisible({ timeout: READY_MS });
    await page.getByRole("button", { name: "Consumo del sistema" }).click();
    const panel = page.getByRole("dialog");
    await expect(panel).toContainText("Ahora: GPU en 1 de 1 terminal.");
    await panel.getByRole("button", { name: "CPU", exact: true }).click();
    await expect(screen.locator(".xterm-rows")).toHaveCount(1);
    await expect(screen.locator("canvas")).toHaveCount(0);
    await expect(panel).toContainText("Ahora: CPU en 1 terminal.");
    await panel.getByRole("button", { name: "Automático" }).click();
    await expect(screen.locator("canvas").first()).toBeVisible();
    await expect(screen.locator(".xterm-rows")).toHaveCount(0);
  } finally {
    await removeTerminals(request, [terminal.id]);
  }
});

test("a Mesa switch lets the closed terminal's GPU context go", async ({ page, request }) => {
  await resetWorkspace(request);
  const open = async () => {
    const res = await request.post("/api/terminals", {
      headers: { origin, "content-type": "application/json" },
      data: { harness: "shell", location: "app" },
    });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { terminal: { id: string } }).terminal.id;
  };
  const a = await open();
  const b = await open();
  await addMesa(request, { id: "gpu-a", name: "GPU A", ids: [a] });
  await addMesa(request, { id: "gpu-b", name: "GPU B", ids: [b] });
  // Every WebGL2 context the page makes, kept to ask which are still alive. A browser gives a
  // page 16; one left to the garbage collector at each switch drops the oldest past that.
  await page.addInitScript(() => {
    const made: WebGL2RenderingContext[] = [];
    Object.assign(window, { madeGl: made });
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof get>
    ) {
      const ctx = get.apply(this, args);
      if (ctx instanceof WebGL2RenderingContext && !made.includes(ctx)) made.push(ctx);
      return ctx;
    } as typeof get;
  });
  const drawn = (id: string) => page.locator(`[data-terminal-id="${id}"] .xterm-screen canvas`);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/terminales?mesa=gpu-a");
    await expect(drawn(a).first()).toBeVisible({ timeout: READY_MS });
    for (let i = 1; i <= 6; i++) {
      const [name, id] = i % 2 ? ["GPU B", b] : ["GPU A", a];
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(drawn(id).first()).toBeVisible({ timeout: READY_MS });
    }
    const alive = () =>
      page.evaluate(
        () =>
          (window as unknown as { madeGl: WebGL2RenderingContext[] }).madeGl.filter(
            (gl) => !gl.isContextLost(),
          ).length,
      );
    // Only the terminal on screen holds one; the GPU probe lets its own go at once.
    expect(await alive()).toBe(1);
  } finally {
    await removeTerminals(request, [a, b]);
  }
});
