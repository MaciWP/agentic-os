import { expect, type Page, test } from "@playwright/test";
import {
  getWorkspace,
  origin,
  removeTerminals,
  resetWorkspace,
  workspaceIntent,
} from "./helpers.ts";

// The Mesa list's own actions: close a Mesa from its card, drop loose terminals on a card, and
// remove a block. Runs under e2e:isolated, never against the user's server.
const headers = { origin, "content-type": "application/json" };
const ids: string[] = [];
const loose = (page: Page, id: string) => page.locator(`[data-loose="${id}"]`);
const tabs = (page: Page) => page.getByRole("tab");

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
  await resetWorkspace(request);
  await page.goto("/terminales");
  await expect(page.getByText("Cargando mesas compartidas…", { exact: true })).toHaveCount(0);
  // Late bars above the rail move it; drags measure once.
  await page.waitForLoadState("networkidle");
});
test.afterAll(async ({ request }) => {
  await removeTerminals(request, ids);
});

test("a Mesa closes from its card's menu; Supr asks first when it has terminals, and they wait outside the Mesas", async ({
  page,
  request,
}) => {
  const [id] = ids as [string];
  await workspaceIntent(request, { kind: "add", mesa: "mesa-1", tile: id });
  await page.reload();
  await expect(tabs(page)).toHaveCount(1);
  // An empty Mesa closes at once.
  await page.getByRole("button", { name: "Nueva Mesa", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  const second = page.locator('[data-mesa]:not([data-mesa="mesa-1"])');
  await second.hover();
  // The card fills the list's width, its «⋯» at the right edge.
  const list = await page.getByRole("tablist").last().boundingBox();
  const row = await second.boundingBox();
  const more = page.getByRole("button", { name: "Opciones de Mesa 2", exact: true });
  const x = await more.boundingBox();
  if (!list || !row || !x) throw new Error("no box");
  expect(row.width).toBeGreaterThan(list.width - 12);
  expect(list.x + list.width - (x.x + x.width)).toBeLessThan(12);
  await more.click();
  await page.getByRole("menuitem", { name: /^Cerrar Mesa/ }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("alertdialog", { name: "Cerrar Mesa" })).toHaveCount(0);
  // Supr on one with a terminal asks; the terminal keeps running, outside the Mesas.
  await page.getByRole("button", { name: "Nueva Mesa", exact: true }).click();
  const first = page.locator('[data-mesa="mesa-1"]');
  await first.focus();
  await page.keyboard.press("Delete");
  const ask = page.getByRole("alertdialog", { name: "Cerrar Mesa" });
  await expect(ask).toContainText("1 terminales siguen abiertas");
  await ask.getByRole("button", { name: "Cerrar Mesa" }).click();
  await expect(first).toHaveCount(0);
  await expect(loose(page, id)).toBeVisible();
  // Dragged from «Fuera de las Mesas» onto the open Mesa, it goes into it.
  await loose(page, id).dragTo(tabs(page).first());
  await expect(loose(page, id)).toHaveCount(0);
  await expect(page.locator(`[data-terminal-id="${id}"]`)).toBeVisible();
});

test("a loose terminal dropped on a card joins that Mesa, and a block removed from its editor keeps its Mesas", async ({
  page,
  request,
}) => {
  const [, id] = ids as [string, string];
  await page.getByRole("button", { name: "Nuevo bloque de Mesas" }).click();
  await page.getByRole("textbox", { name: "Nombre del bloque" }).fill("Trabajo");
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await page.getByRole("button", { name: "Nueva Mesa", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  // Onto the Mesa that is not open: it goes there, and that Mesa opens.
  await expect(loose(page, id)).toBeVisible();
  await loose(page, id).dragTo(page.locator('[data-mesa="mesa-1"]'));
  await expect(loose(page, id)).toHaveCount(0);
  await expect
    .poll(async () => (await getWorkspace(request)).mesas.find((m) => m.id === "mesa-1")?.ids)
    .toContain(id);
  // In the block through its card's menu, then the block goes from its editor.
  const card = page.locator('[data-mesa="mesa-1"]');
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mover a bloque" }).click();
  await page.getByRole("menuitem", { name: "Trabajo" }).click();
  await expect(card.locator("[data-block]")).toBeVisible();
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Editar bloque «Trabajo»…" }).click();
  await page.getByRole("button", { name: "Borrar bloque" }).click();
  await expect(card.locator("[data-block]")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(2);
  expect((await getWorkspace(request)).blocks).toEqual([]);
});
