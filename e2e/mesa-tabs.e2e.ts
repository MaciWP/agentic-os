import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Workspace } from "../web/features/terminals/mesas.ts";
import {
  appNode,
  getWorkspace,
  mesaMenu,
  noClippedControls,
  openTree,
  origin,
  removeTerminals,
  resetWorkspace,
  rowPlus,
  tileAction,
  typeIn,
  waitReady,
  workspaceIntent,
} from "./helpers.ts";

const headers = { origin, "content-type": "application/json" };
const ids: string[] = [];
const workspace = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("aos.mesas") ?? "null") as Workspace);
const tile = (page: Page, id: string) => page.locator(`[data-terminal-id="${id}"]`);
// A tile moved by its header with real pointer events, as in grid.e2e.ts.
const dragHeader = async (page: Page, id: string, to: Locator) => {
  // The work bar loads late and pushes the Mesa down; measured before it, the drag misses.
  await expect(page.getByText("Rituales", { exact: true })).toBeVisible();
  const h = await tile(page, id).locator("header").boundingBox();
  const b = await to.boundingBox();
  if (!h || !b) throw new Error("no box");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2 + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
};
// A card's block shows as a dot of its colour.
const dot = (page: Page, mesa: string) => page.locator(`[data-mesa="${mesa}"] [data-block]`);
const activeId = async (page: Page) =>
  (await page.locator('[data-mesa][data-state="active"]').getAttribute("data-mesa")) ?? "";
const rename = async (page: Page, name: string) => {
  await (await mesaMenu(page)).getByRole("menuitem", { name: /^Renombrar/ }).click();
  await page.getByRole("textbox", { name: "Nombre de la Mesa" }).fill(name);
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
};

test.beforeAll(async ({ request }) => {
  for (let n = 0; n < 3; n++) {
    const res = await request.post("/api/terminals", {
      headers,
      data: { harness: "shell", location: "app" },
    });
    expect(res.ok()).toBe(true);
    ids.push((await res.json()).terminal.id);
  }
});
// Membership is now server-owned: each scenario explicitly establishes its initial state.
// This file runs under e2e:isolated (one worker, playwright.config.ts), never against the user's server.
test.beforeEach(async ({ request, page }) => {
  await resetWorkspace(request);
  await page.goto("/terminales");
  await expect(page.getByText("Cargando mesas compartidas…", { exact: true })).toHaveCount(0);
});
test.afterAll(async ({ request }) => {
  await removeTerminals(request, ids);
});

test("work blocks mark their Mesas, take one from its menu, and reach another device", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "Nueva Mesa" }).click();
  await page.getByRole("button", { name: "Nuevo bloque de Mesas" }).click();
  await page.getByRole("textbox", { name: "Nombre del bloque" }).fill("Trabajo");
  await page.getByRole("button", { name: "Color Verde" }).click();
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await expect
    .poll(async () => (await getWorkspace(request)).blocks.map((b) => b.name))
    .toEqual(["Trabajo"]);

  // The open Mesa through its card's «Mover a bloque».
  const open = await activeId(page);
  await (await mesaMenu(page)).getByRole("menuitem", { name: "Mover a bloque" }).click();
  await page.getByRole("menuitem", { name: "Trabajo" }).click();
  await expect(dot(page, open)).toHaveAttribute("data-block", "green");
  // The other one through its «⋯».
  await page.getByRole("button", { name: "Opciones de Mesa 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Mover a bloque" }).click();
  await page.getByRole("menuitem", { name: "Trabajo" }).click();
  await expect(dot(page, "mesa-1")).toHaveAttribute("data-block", "green");
  await noClippedControls(page);
  await page.screenshot({ path: "data/evidence/mesa-blocks/grouped-1280.png" });

  await page.reload();
  await expect(page.getByText("Cargando mesas compartidas…", { exact: true })).toHaveCount(0);
  await expect(dot(page, "mesa-1")).toHaveAttribute("data-block", "green");
  const shared = await getWorkspace(request);
  expect(shared.blocks.map((b) => [b.name, b.color])).toEqual([["Trabajo", "green"]]);
  expect(shared.mesas.every((m) => m.block === shared.blocks[0]?.id)).toBe(true);

  // Another device sees a block change live.
  const other = await page.context().browser()?.newPage();
  if (!other) throw new Error("no browser");
  await other.goto("/terminales");
  await expect(dot(other, "mesa-1")).toHaveAttribute("data-block", "green");
  await page.getByRole("button", { name: "Opciones de Mesa 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Mover a bloque" }).click();
  await page.getByRole("menuitem", { name: "Bloque nuevo…" }).click();
  await page.getByRole("textbox", { name: "Nombre del bloque" }).fill("Personal");
  await page.getByRole("button", { name: "Color Rosa" }).click();
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await expect(dot(other, "mesa-1")).toHaveAttribute("data-block", "rose");
  await other.close();
});

test("a second and third block are made from the rail and the card menu while the open Mesa's shell has the focus", async ({
  page,
  request,
}) => {
  await workspaceIntent(request, { kind: "create", mesa: "m2", name: "Otra" });
  await workspaceIntent(request, {
    kind: "block-create",
    block: "b-work",
    name: "Trabajo",
    color: "rose",
    mesas: ["m2"],
  });
  await page.goto(`/terminales?ids=${ids[0]}`);
  await waitReady(tile(page, ids[0] ?? ""));
  await tile(page, ids[0] ?? "")
    .locator(".xterm")
    .click();
  await page.getByRole("button", { name: "Nuevo bloque de Mesas" }).click();
  await page.getByRole("textbox", { name: "Nombre del bloque" }).fill("Personal");
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await expect
    .poll(async () => (await getWorkspace(request)).blocks.map((b) => b.name))
    .toEqual(["Trabajo", "Personal"]);

  // «Mover a bloque › Bloque nuevo…» makes one and puts the open Mesa in it.
  await tile(page, ids[0] ?? "")
    .locator(".xterm")
    .click();
  await (await mesaMenu(page)).getByRole("menuitem", { name: "Mover a bloque" }).click();
  await page.getByRole("menuitem", { name: "Bloque nuevo…" }).click();
  await page.getByRole("textbox", { name: "Nombre del bloque" }).fill("Agentic");
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await expect(dot(page, await activeId(page))).toBeVisible();
  const shared = await getWorkspace(request);
  expect(shared.blocks.map((b) => b.name)).toEqual(["Trabajo", "Personal", "Agentic"]);
  const agentic = shared.blocks.find((b) => b.name === "Agentic")?.id;
  expect(shared.mesas.filter((m) => m.block === agentic).map((m) => m.id)).toEqual([
    await activeId(page),
  ]);
});

test("eight Mesas in four blocks fit the rail at 1280 px, each name whole and marked", async ({
  page,
  request,
}) => {
  const names = [
    "ABC-1160",
    "catalog-curation",
    "tablas-prosa",
    "claude-local",
    "plan-pagina-hoy",
    "voz-latencia",
    "cv-astro",
    "poneglyph-chat",
  ];
  await workspaceIntent(request, { kind: "rename", mesa: "mesa-1", name: names[0] ?? "" });
  for (const [i, name] of names.slice(1).entries())
    await workspaceIntent(request, { kind: "create", mesa: `m${i + 2}`, name });
  const blocks = [
    ["Trabajo", "blue", ["mesa-1", "m2"]],
    ["Agentic OS", "violet", ["m3", "m4", "m5", "m6"]],
    ["Personal", "rose", ["m7"]],
    ["Poneglyph", "amber", ["m8"]],
  ] as const;
  for (const [name, color, mesas] of blocks)
    await workspaceIntent(request, {
      kind: "block-create",
      block: `b-${name}`,
      name,
      color,
      mesas: [...mesas],
    });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/terminales");
  await expect(page.locator("[data-mesa] [data-block]")).toHaveCount(8);
  await noClippedControls(page);
  await page.screenshot({ path: "data/evidence/mesa-blocks/eight-1280.png" });
  // A card per Mesa, none cut.
  for (const name of names)
    await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  expect(
    await page
      .getByRole("tab")
      .evaluateAll(
        (els) =>
          els
            .flatMap((el) => [...el.querySelectorAll(".truncate")])
            .filter((el) => el.scrollWidth > el.clientWidth + 1).length,
      ),
  ).toBe(0);
});

test("two named Mesas restore their layouts; hidden shells keep running and move without duplicates", async ({
  page,
}) => {
  await page.goto(`/terminales?ids=${ids.join(",")}`);
  await waitReady(tile(page, ids[0] ?? ""));
  await rename(page, "Backend");
  await page.getByRole("button", { name: "Distribución: Columnas", exact: true }).click();
  const border = page.getByRole("separator").first();
  await border.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Nueva Mesa" }).click();
  // The second one through ⌘K, which lists the open Mesa's commands.
  await page.keyboard.press("Meta+K");
  await page.keyboard.type("renombrar la mesa");
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "Nombre de la Mesa" }).fill("Revisión");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await page.getByRole("tab", { name: "Backend", exact: true }).click();
  // Columnas beside the rail can leave the header under 26rem, the action in «Más acciones».
  await (await tileAction(tile(page, ids[1] ?? ""), "Mover a otra Mesa")).click();
  await page.getByRole("menuitem", { name: "Revisión", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Revisión", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tile(page, ids[1] ?? "")).toBeVisible();
  await expect(tile(page, ids[0] ?? "")).toHaveCount(0);
  await typeIn(tile(page, ids[1] ?? ""), "sleep 1; echo $((41*43))hidden");
  await page.getByRole("tab", { name: "Backend", exact: true }).click();
  await typeIn(tile(page, ids[0] ?? ""), "echo $((17*19))visible");
  await expect(tile(page, ids[0] ?? "").locator(".xterm-rows")).toContainText("323visible");
  await page.getByRole("tab", { name: "Revisión", exact: true }).click();
  await expect(tile(page, ids[1] ?? "").locator(".xterm-rows")).toContainText("1763hidden");
  const before = await workspace(page);
  expect(before.mesas.map((m) => m.ids)).toEqual([[ids[0], ids[2]], [ids[1]]]);
  await page.reload();
  await expect(tile(page, ids[1] ?? "")).toBeVisible();
  expect((await workspace(page)).mesas).toEqual(before.mesas);
  for (let i = 0; i < 3; i++) {
    await page.getByRole("tab", { name: "Backend", exact: true }).click();
    await page.getByRole("tab", { name: "Revisión", exact: true }).click();
  }
  await typeIn(tile(page, ids[1] ?? ""), "echo $((13*23))rapid");
  await expect(tile(page, ids[1] ?? "").locator(".xterm-rows")).toContainText("299rapid");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await noClippedControls(page);
    await page.screenshot({ path: `data/evidence/mesas/tabs-${width}.png` });
  }
});

test("keyboard switching, history, owner links and closing a Mesa preserve the shells", async ({
  page,
  request,
}) => {
  await page.goto(`/terminales?ids=${ids[0]}`);
  await page.getByRole("button", { name: "Nueva Mesa" }).click();
  await expect(page.getByRole("tab", { name: "Mesa 2", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("tab", { name: "Mesa 1", exact: true })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Mesa 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(tile(page, ids[0] ?? "")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Mesa 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goto(`/terminales?mesa=${(await workspace(page)).activeId}&t=${ids[0]}`);
  await expect(page.getByRole("tab", { name: "Mesa 1", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await (await mesaMenu(page)).getByRole("menuitem", { name: /^Cerrar Mesa/ }).click();
  await expect(page.getByRole("tab", { name: "Mesa 1", exact: true })).toHaveCount(0);
  const list = await (await request.get("/api/terminals")).json();
  expect(list.terminals.find((t: { id: string }) => t.id === ids[0]).state).toBe("running");
  expect((await workspace(page)).mesas.flatMap((m) => m.ids)).not.toContain(ids[0]);
  await page.goto(`/terminales?t=${ids[0]}`);
  await typeIn(tile(page, ids[0] ?? ""), "echo $((11*29))recovered");
  await expect(tile(page, ids[0] ?? "").locator(".xterm-rows")).toContainText("319recovered");
});

test("unavailable storage keeps Mesas usable and warns about local panel layouts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("storage disabled");
    };
  });
  await page.goto("/terminales");
  await expect(page.getByRole("alert")).toContainText(
    "La distribución de los paneles no se guardará",
  );
  await page.getByRole("button", { name: "Nueva Mesa" }).click();
  await expect(page.getByRole("tab", { name: "Mesa 2", exact: true })).toBeVisible();
});

test("an inactive Mesa shows attention and selecting its tab does not acknowledge the terminal", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).terminal.id as string;
  ids.push(id);
  await page.goto(`/terminales?ids=${id}`);
  await waitReady(tile(page, id));
  await page.getByRole("button", { name: "Nueva Mesa" }).click();
  await request.post(`/api/terminals/${id}/stop`, { headers });
  // The card names the Mesa and why it waits (how the shell ended: a signal leaves a code, so it
  // counts as failed).
  const waiting = page.getByRole("tab", { name: /^Mesa 1\s*(Ha fallado|Ha terminado)$/ });
  await expect(waiting).toBeVisible();
  await expect(page.getByRole("tab", { name: "Mesa 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await waiting.click();
  await expect(waiting).toBeVisible();
  await expect(tile(page, id).locator('[data-part="attention"]')).toBeVisible();
  await tile(page, id).click();
  // Seen: the wait goes, the phase stays while the ended shell is in the Mesa.
  await expect(
    page.getByRole("tab", { name: /^Mesa 1\s*\((terminada con código \d+|terminada)\)$/ }),
  ).toBeVisible();
  await expect(tile(page, id).locator('[data-part="attention"]')).toHaveCount(0);
});

test("a delayed launch returns to its origin and uses the active Mesa if its origin closed", async ({
  page,
}) => {
  await page.goto("/terminales");
  await expect.poll(() => workspace(page)).toBeTruthy();
  for (const closeOrigin of [false, true]) {
    const before = await workspace(page);
    const source = before.activeId;
    const sourceName = before.mesas.find((m) => m.id === source)?.name ?? "";
    const responseReady = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/terminals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const id = (await response.json()).terminal.id as string;
      ids.push(id);
      responseReady.resolve(id);
      await release.promise;
      await route.fulfill({ response });
    });
    await openTree(page);
    const app = await appNode(page);
    await (await rowPlus(page, app.location, app.name, "Shell")).click();
    const id = await responseReady.promise;
    await page.getByRole("button", { name: "Nueva Mesa" }).click();
    await expect.poll(async () => (await workspace(page)).activeId).not.toBe(source);
    const target = (await workspace(page)).activeId;
    if (closeOrigin) {
      await page.getByRole("tab", { name: sourceName, exact: true }).click();
      await (await mesaMenu(page)).getByRole("menuitem", { name: /^Cerrar Mesa/ }).click();
    }
    const fallback = (await workspace(page)).activeId;
    release.resolve();
    await expect
      .poll(async () => (await workspace(page)).activeId)
      .toBe(closeOrigin ? fallback : source);
    await expect(tile(page, id)).toBeVisible();
    expect(
      (await workspace(page)).mesas.find((m) => m.id === (closeOrigin ? fallback : source))?.ids,
    ).toContain(id);
    await page.unrouteAll({ behavior: "wait" });
    if (!closeOrigin) await page.goto(`/terminales?mesa=${target}`);
  }
});

test("a Mesa names itself after its ticket, takes an emoji, and takes a tile dropped on its tab", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app", ticket: "ABC-9" },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).terminal.id as string;
  ids.push(id);
  await page.goto(`/terminales?ids=${id},${ids[0]}`);
  await waitReady(tile(page, id));
  const auto = page.getByRole("tab", { name: "ABC-9", exact: true });
  await expect(auto).toBeVisible();
  await auto.dblclick();
  await page.getByRole("button", { name: "Icono 🐛" }).click();
  await page.getByRole("textbox", { name: "Nombre de la Mesa" }).fill("Bugs");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  // A chosen name keeps the ticket's badge before it.
  const named = page.getByRole("tab", { name: /^ABC-9\s?Bugs$/ });
  await expect(named).toContainText("🐛");
  await named.focus();
  await page.keyboard.press("F2");
  await page.getByRole("textbox", { name: "Nombre de la Mesa" }).fill("");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(auto).toContainText("🐛");
  expect((await workspace(page)).mesas[0]?.name).toBe("🐛 Mesa 1");
  // A reload drops a rename still on its way: wait until the server has it.
  await expect
    .poll(async () => (await getWorkspace(request)).mesas.some((m) => m.name === "🐛 Mesa 1"))
    .toBe(true);
  await page.reload();
  await expect(auto).toBeVisible();
  await expect(page.getByText("Cargando mesas compartidas…", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Nueva Mesa" }).click();
  await auto.click();
  const target = page.getByRole("tab", { name: "Mesa 2", exact: true });
  await expect(target).toBeVisible();
  await dragHeader(page, ids[0] ?? "", target);
  await expect(target).toHaveAttribute("aria-selected", "true");
  await expect(tile(page, ids[0] ?? "")).toBeVisible();
  expect((await workspace(page)).mesas.map((m) => m.ids)).toEqual([[id], [ids[0]]]);
});

test("many Mesas never scroll the page: the list scrolls in the rail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (let n = 0; n < 14; n++) await page.getByRole("button", { name: "Nueva Mesa" }).click();
  await expect(page.getByRole("tab")).toHaveCount(15);
  const top = page.locator("[data-new-mesa]").locator("xpath=..");
  expect(await top.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.documentElement.scrollHeight - document.documentElement.clientHeight,
    ]),
  ).toEqual([0, 0]);
  // The active Mesa, the last one created, is the selected row.
  await expect(page.getByRole("tab", { name: "Mesa 15", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await noClippedControls(page);
});

test("tabs reorder by dragging or Alt+arrows, and the order survives a reload", async ({
  page,
}) => {
  for (let n = 0; n < 2; n++) await page.getByRole("button", { name: "Nueva Mesa" }).click();
  // Empty Mesas stand among the finished ones.
  const tabs = page.getByRole("tablist", { name: "Terminadas" }).getByRole("tab");
  // A tab's text is its name, then what it holds on a second line.
  const order = (...names: string[]) => names.map((n) => new RegExp(`^${n}Sin terminales$`));
  await expect(tabs).toHaveText(order("Mesa 1", "Mesa 2", "Mesa 3"));
  const third = page.getByRole("tab", { name: "Mesa 3", exact: true });
  const first = await page.getByRole("tab", { name: "Mesa 1", exact: true }).boundingBox();
  if (!first) throw new Error("no box");
  // Dropped on the top half of Mesa 1: it goes first.
  await third.dragTo(page.getByRole("tab", { name: "Mesa 1", exact: true }), {
    targetPosition: { x: first.width / 2, y: 4 },
  });
  await expect(tabs).toHaveText(order("Mesa 3", "Mesa 1", "Mesa 2"));
  await third.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(tabs).toHaveText(order("Mesa 1", "Mesa 3", "Mesa 2"));
  await expect(third).toBeFocused();
  await page.reload();
  await expect(page.getByText("Cargando mesas compartidas…", { exact: true })).toHaveCount(0);
  await expect(tabs).toHaveText(order("Mesa 1", "Mesa 3", "Mesa 2"));
});

test("a Mesa left empty offers to close itself, without taking the focus", async ({ page }) => {
  await page.goto(`/terminales?ids=${ids[0]},${ids[1]}`);
  await waitReady(tile(page, ids[0] ?? ""));
  await page.getByRole("button", { name: "Nueva Mesa" }).click();
  await page.getByRole("tab", { name: "Mesa 1", exact: true }).click();
  // Its last tile removed with "Quitar": kept.
  await tile(page, ids[1] ?? "")
    .getByRole("button", { name: /^Quitar .* de la cuadrícula$/ })
    .click();
  await expect(page.getByRole("alertdialog", { name: "Mesa vacía" })).toHaveCount(0);
  await tile(page, ids[0] ?? "")
    .getByRole("button", { name: /^Quitar .* de la cuadrícula$/ })
    .click();
  const ask = page.getByRole("alertdialog", { name: "Mesa vacía" });
  await expect(ask).toContainText("«Mesa 1» se ha quedado vacía");
  await expect(ask.getByRole("button", { name: "Mantener" })).not.toBeFocused();
  await ask.getByRole("button", { name: "Mantener" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Mesa 1", exact: true })).toBeVisible();
  // Its last terminal moved to another Mesa: closed on request; the shell keeps running.
  await page.goto(`/terminales?t=${ids[0]}`);
  await waitReady(tile(page, ids[0] ?? ""));
  await dragHeader(page, ids[0] ?? "", page.getByRole("tab", { name: "Mesa 2", exact: true }));
  await expect(page.getByRole("tab", { name: "Mesa 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tile(page, ids[0] ?? "")).toBeVisible();
  await expect(ask).toContainText("«Mesa 1» se ha quedado vacía");
  await ask.getByRole("button", { name: "Cerrar Mesa" }).click();
  await expect(page.getByRole("tab", { name: "Mesa 1", exact: true })).toHaveCount(0);
  await typeIn(tile(page, ids[0] ?? ""), "echo $((7*11))kept");
  await expect(tile(page, ids[0] ?? "").locator(".xterm-rows")).toContainText("77kept");
});

test("a tile dropped on the list's free room opens a new Mesa with that terminal", async ({
  page,
}) => {
  await page.goto(`/terminales?ids=${ids[0]},${ids[1]}`);
  await waitReady(tile(page, ids[0] ?? ""));
  await dragHeader(page, ids[0] ?? "", page.locator("[data-new-mesa]"));
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tile(page, ids[0] ?? "")).toBeVisible();
  await expect(tile(page, ids[1] ?? "")).toHaveCount(0);
  expect((await workspace(page)).mesas.map((m) => m.ids)).toEqual([[ids[1]], [ids[0]]]);
  await typeIn(tile(page, ids[0] ?? ""), "echo $((13*17))fresh");
  await expect(tile(page, ids[0] ?? "").locator(".xterm-rows")).toContainText("221fresh");
});

// AC6 of plan 007: each tab states its own add; the server keeps both, in any arrival order.
test("two tabs adding different terminals to one Mesa at once both end with both", async ({
  page,
  context,
  request,
}) => {
  const other = await context.newPage();
  const [a, b] = [ids[1] ?? "", ids[2] ?? ""];
  await other.goto("/terminales?mesa=mesa-1");
  await expect(other.getByText("Cargando mesas compartidas…", { exact: true })).toHaveCount(0);
  await Promise.all([
    page.goto(`/terminales?mesa=mesa-1&t=${a}`),
    other.goto(`/terminales?mesa=mesa-1&t=${b}`),
  ]);
  for (const tab of [page, other])
    for (const id of [a, b]) await expect(tile(tab, id)).toBeVisible();
  expect((await getWorkspace(request)).mesas.find((m) => m.id === "mesa-1")?.ids.sort()).toEqual(
    [a, b].sort(),
  );
  // A terminal shown in both tabs says «Abierta en otra ventana» in one of them; no Mesa error.
  for (const tab of [page, other])
    await expect(
      tab.getByRole("alert").filter({ hasNotText: "Abierta en otra ventana" }),
    ).toHaveCount(0);
  await other.close();
});
