import { expect, type Page, test } from "@playwright/test";
import { addMesa, origin, removeTerminals, resetWorkspace, workspaceIntent } from "./helpers.ts";

// The Mesa page's three views: Terminales, Mosaico and Lienzo. Opening a Mesa from an overview
// and coming back. Runs under e2e:isolated, never against the user's server.
const headers = { origin, "content-type": "application/json" };
const ids: string[] = [];
const views = (page: Page) => page.getByRole("group", { name: "Vista de la Mesa" });
const view = (page: Page, name: string) => views(page).getByRole("button", { name, exact: true });
const canvas = (page: Page) => page.getByRole("region", { name: "Lienzo de las Mesas" });
const zoom = (page: Page) => page.getByRole("group", { name: "Zoom del lienzo" }).locator("output");

test.beforeAll(async ({ request }) => {
  for (let n = 0; n < 2; n++) {
    const res = await request.post("/api/terminals", {
      headers,
      data: { harness: "shell", location: "app" },
    });
    expect(res.ok()).toBe(true);
    ids.push((await res.json()).terminal.id);
  }
});
test.beforeEach(async ({ request, page }) => {
  const [first, second] = ids as [string, string];
  await resetWorkspace(request);
  await workspaceIntent(request, { kind: "add", mesa: "mesa-1", tile: first });
  await addMesa(request, { id: "mesa-2", name: "Revisión", ids: [second] });
  await page.goto("/terminales?mesa=mesa-1");
  await expect(page.getByText("Cargando mesas compartidas…", { exact: true })).toHaveCount(0);
});
test.afterAll(async ({ request }) => {
  await removeTerminals(request, ids);
});

test("Mosaico shows every Mesa; a cell opens it, «Volver» returns, and a plain visit keeps the view", async ({
  page,
}) => {
  await expect(view(page, "Terminales")).toHaveAttribute("aria-pressed", "true");
  await view(page, "Mosaico").click();
  await expect(page).toHaveURL(/view=mosaico/);
  await expect(view(page, "Mosaico")).toHaveAttribute("aria-pressed", "true");
  const cells = page.locator("[data-mesa-cell]");
  await expect(cells).toHaveCount(2);
  // The overview has no rail: it already shows every Mesa.
  await expect(page.getByRole("region", { name: "Mesas y proyectos" })).toHaveCount(0);
  await page.locator('[data-mesa-cell="mesa-2"]').click();
  await expect(page).toHaveURL(/mesa=mesa-2/);
  await expect(page).not.toHaveURL(/view=/);
  await expect(view(page, "Terminales")).toHaveAttribute("aria-pressed", "true");
  const back = page.getByRole("button", { name: "Volver al Mosaico" });
  await back.click();
  await expect(page).toHaveURL(/view=mosaico/);
  await expect(page.locator('[data-mesa-cell="mesa-2"]')).toHaveAttribute("aria-current", "true");
  // The browser's Back leads there too; a plain visit returns to the view seen last.
  await page.goto("/terminales");
  await expect(page).toHaveURL(/view=mosaico/);
  await view(page, "Terminales").click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(page.getByRole("button", { name: /^Volver al/ })).toHaveCount(0);
  await page.goto("/terminales");
  await expect(page).not.toHaveURL(/view=/);
});

test("Lienzo puts every terminal on one canvas: zoom, ⇧1, arrows, and a card opens its Mesa", async ({
  page,
}) => {
  const [, second] = ids as [string, string];
  await view(page, "Lienzo").click();
  await expect(page).toHaveURL(/view=lienzo/);
  await expect(canvas(page)).toBeVisible();
  await expect(page.locator("[data-card]")).toHaveCount(2);
  await expect(page.locator("[data-frame]")).toHaveCount(2);
  const fitted = await zoom(page).textContent();
  await page.getByRole("button", { name: "Acercar", exact: true }).click();
  await expect(zoom(page)).not.toHaveText(fitted ?? "");
  // ⇧1 fits everything again.
  await page.locator(`[data-card="${second}"]`).focus();
  await page.keyboard.press("Shift+Digit1");
  await expect(zoom(page)).toHaveText(fitted ?? "");
  // Arrows move the focus by position, and the canvas never scrolls under the camera.
  await page.keyboard.press("ArrowLeft");
  const moved = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.dataset.card ?? el?.dataset.frame ?? null;
  });
  expect(moved).not.toBeNull();
  expect(moved).not.toBe(second);
  expect(await canvas(page).evaluate((el) => el.scrollLeft + el.scrollTop)).toBe(0);
  await page.locator(`[data-card="${second}"]`).click();
  await expect(page).toHaveURL(/mesa=mesa-2/);
  await page.getByRole("button", { name: "Volver al Lienzo" }).click();
  await expect(page).toHaveURL(/view=lienzo/);
  await expect(canvas(page)).toBeVisible();
});
