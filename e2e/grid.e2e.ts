import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  currentMesa,
  noClippedControls,
  openTree,
  origin,
  removeTerminals,
  resetWorkspace,
  typeIn,
} from "./helpers.ts";

// The grid: three shells from two projects side by side, each taking its own keys. Only shells
// are launched, at repo:contract and repo:frontend, where no other suite counts terminals; they
// are stopped and removed again (DELETE answers removed false until the shell has exited).
const EVIDENCE = "data/evidence/w6";
const headers = { origin, "content-type": "application/json" };

// Each test sets its own grid; none inherits the order or the members an earlier one left.
// The terminals in the page's order, which is the layout's reading order (their numbers). It is
// this browser's view; the Mesa's members are a set the server keeps.
const readingOrder = (page: Page) =>
  page
    .locator("[data-terminal-id]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal-id")));

test.beforeEach(async ({ request }) => resetWorkspace(request));

async function shoot(page: Page, name: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await noClippedControls(page);
    for (const scheme of ["dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${EVIDENCE}/${name}-${width}-${scheme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

// A tile moved by its header, with real pointer events, to a point another call returns.
async function dragHeader(page: Page, tile: Locator, to: () => Promise<{ x: number; y: number }>) {
  const h = await tile.locator("header").boundingBox();
  if (!h) throw new Error("no header");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2 + 20, { steps: 4 });
  const at = await to();
  await page.mouse.move(at.x, at.y, { steps: 8 });
  await page.mouse.up();
}

const middle = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test.describe("terminal grid", () => {
  const ids: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (const location of ["repo:contract", "repo:contract", "repo:frontend"]) {
      const res = await request.post("/api/terminals", {
        headers,
        data: { harness: "shell", location },
      });
      expect(res.ok()).toBe(true);
      ids.push(((await res.json()) as { terminal: { id: string } }).terminal.id);
    }
  });

  test.afterAll(async ({ request }) => {
    await removeTerminals(request, ids);
  });

  test("each tile takes its own keys, and a tile taken by another window can be brought back", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(3);
    // The rail opens with the Mesas over the projects; there is no right rail.
    await expect(page.getByRole("button", { name: "Ocultar el carril" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByRole("button", { name: "Mostrar tickets y PR" })).toHaveCount(0);

    // Distinct results per tile: each shell printed only what was typed into it.
    for (const [i, n] of [11, 12, 13].entries()) await typeIn(tiles.nth(i), `echo $((${n}*${n}))g`);
    for (const [i, n] of [121, 144, 169].entries()) {
      await expect(tiles.nth(i).locator(".xterm-rows")).toContainText(`${n}g`);
      for (const other of [121, 144, 169].filter((x) => x !== n))
        await expect(tiles.nth(i).locator(".xterm-rows")).not.toContainText(`${other}g`);
    }
    await shoot(page, "grid");

    // A window of its own takes the second terminal; only that tile says so.
    const other = await context.newPage();
    await other.goto(`/terminal/${ids[1]}`);
    await expect(other.getByText("en marcha")).toBeVisible();
    await expect(tiles.nth(1).getByText("Abierta en otra ventana.")).toBeVisible();
    await expect(page.getByText("Abierta en otra ventana.")).toHaveCount(1);

    await tiles.nth(1).getByRole("button", { name: "Traer aquí" }).click();
    await expect(page.getByText("Abierta en otra ventana.")).toHaveCount(0);
    await expect(other.getByText("Abierta en otra ventana.")).toBeVisible();
    await typeIn(tiles.nth(1), "echo $((7*7))back");
    await expect(tiles.nth(1).locator(".xterm-rows")).toContainText("49back");
    await other.close();
  });

  test("every tile's last row fits its screen, whatever height the Mesa leaves it", async ({
    page,
  }) => {
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const screens = page.locator("section[aria-label^='Shell en '] [data-terminal-screen]");
    await expect(screens).toHaveCount(3);
    // The rows a fit asks for, against the room the screen has: one pixel over cuts the last row.
    const overflow = () =>
      screens.evaluateAll((els) =>
        els.map((el) => {
          const rows = el.querySelector(".xterm-screen")?.getBoundingClientRect();
          return rows ? Math.round(rows.bottom - el.getBoundingClientRect().bottom) : 999;
        }),
      );
    // Every height in two rows' worth of pixels lands each remainder of the cell height once.
    for (let height = 700; height < 740; height += 1) {
      await page.setViewportSize({ width: 1280, height });
      await expect
        .poll(async () => Math.max(...(await overflow())), { message: `${height}px tall` })
        .toBeLessThanOrEqual(0);
    }
  });

  test("a tile dragged by its header splits another, or runs along a side of the Mesa, and the layout stays", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(3);
    const box = async (i: number) => {
      const b = await tiles.nth(i).boundingBox();
      if (!b) throw new Error(`tile ${i} has no box`);
      return b;
    };
    // The first layout: two tiles on top, the third along the whole bottom.
    expect((await box(2)).y).toBeGreaterThan((await box(0)).y + 100);
    expect((await box(2)).width).toBeGreaterThan((await box(0)).width * 1.8);

    // A mark on each xterm proves that moving a tile never remounts its terminal. The
    // terminal view is lazy: mark it once it is there, not its loading placeholder.
    await expect(tiles.locator(".xterm")).toHaveCount(3);
    await tiles.evaluateAll((els) => {
      for (const el of els) el.querySelector(".xterm")?.setAttribute("data-mark", "kept");
    });
    const drag = (from: number, to: () => Promise<{ x: number; y: number }>) =>
      dragHeader(page, tiles.nth(from), to);

    // The third tile onto the right edge of the first: one row, the second keeps its half.
    // Tiles are numbered, and sit in the page, in reading order: now 1, the moved one, 2.
    await drag(2, async () => {
      const a = await box(0);
      return { x: a.x + a.width - 15, y: a.y + a.height / 2 };
    });
    await expect.poll(async () => await readingOrder(page)).toEqual([ids[0], ids[2], ids[1]]);
    await expect.poll(async () => Math.round((await box(1)).y)).toBe(Math.round((await box(0)).y));
    expect(Math.round((await box(2)).y)).toBe(Math.round((await box(0)).y));
    expect((await box(2)).width).toBeGreaterThan((await box(0)).width * 1.8);

    // The tile numbered 3 now (the second terminal) onto the Mesa's bottom strip: full width.
    await drag(2, async () => {
      const strip = await page.locator("[data-dock='bottom']").boundingBox();
      if (!strip) throw new Error("no bottom strip while dragging");
      return { x: strip.x + strip.width / 2, y: strip.y + strip.height / 2 };
    });
    await expect.poll(async () => (await box(2)).y).toBeGreaterThan((await box(0)).y + 100);
    const bottom = await box(2);
    expect(bottom.width).toBeGreaterThan((await box(0)).width * 1.8);
    await expect(page.locator("[data-dock]")).toHaveCount(0);

    // The first tile onto the middle of the second: they change places, the shape stays.
    await drag(0, async () => {
      const b = await box(1);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await expect.poll(async () => await readingOrder(page)).toEqual([ids[2], ids[0], ids[1]]);
    // ← → on the number swap it with its neighbour, and the keys stay on that number.
    await page.getByRole("button", { name: "Mover la terminal 1" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => await readingOrder(page)).toEqual([ids[0], ids[2], ids[1]]);
    await expect(page.getByRole("button", { name: "Mover la terminal 2" })).toBeFocused();
    await expect(tiles.nth(1)).toHaveAttribute("aria-label", /frontend$/);
    await expect(tiles.locator(".xterm[data-mark='kept']")).toHaveCount(3);
    await expect(
      page.getByRole("separator", { name: "Alto entre las terminales 1 · 2 y 3" }),
    ).toBeVisible();
    await shoot(page, "layout");

    // A reload keeps the layout.
    await page.reload();
    await expect(tiles).toHaveCount(3);
    await expect.poll(async () => Math.round((await box(2)).width)).toBe(Math.round(bottom.width));
  });

  test("presets lay the tiles out at once, a grid's slot takes the next terminal, and a folded rail keeps a strip", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(3);
    const box = async (l: Locator) => {
      const b = await l.boundingBox();
      if (!b) throw new Error("no box");
      return b;
    };
    const tile = (i: number) => box(tiles.nth(i));
    const presets = page.getByRole("group", { name: "Distribución" });
    const slot = page.getByRole("region", { name: "Hueco libre" });

    await presets.getByRole("button", { name: "Columnas" }).click();
    await expect
      .poll(async () => Math.round((await tile(2)).y))
      .toBe(Math.round((await tile(0)).y));
    expect(Math.round((await tile(1)).y)).toBe(Math.round((await tile(0)).y));

    // Principal: the first at full height, the other two stacked beside it.
    await presets.getByRole("button", { name: "Principal" }).click();
    await expect.poll(async () => (await tile(2)).y).toBeGreaterThan((await tile(1)).y + 100);
    expect((await tile(0)).height).toBeGreaterThan((await tile(1)).height * 1.8);
    expect(Math.round((await tile(1)).x)).toBe(Math.round((await tile(2)).x));

    // Cuadrícula: two on top, the third below beside a slot; a tile dropped on it moves there.
    await presets.getByRole("button", { name: "Cuadrícula" }).click();
    await expect(slot).toBeVisible();
    expect(Math.round((await box(slot)).y)).toBe(Math.round((await tile(2)).y));
    await dragHeader(page, tiles.nth(0), () => middle(slot));
    await expect(slot).toHaveCount(0);
    await expect.poll(async () => await readingOrder(page)).toEqual([ids[1], ids[2], ids[0]]);
    expect((await tile(0)).width).toBeGreaterThan((await tile(1)).width * 1.8);

    // A slot offers a Claude and the search; a terminal opened from «Fuera de las Mesas» takes it.
    await presets.getByRole("button", { name: "Cuadrícula" }).click();
    const res = await request.post("/api/terminals", {
      headers,
      data: { harness: "shell", location: "repo:frontend" },
    });
    const extra = ((await res.json()) as { terminal: { id: string } }).terminal.id;
    try {
      await expect(slot.getByRole("button", { name: "Claude", exact: true })).toBeVisible();
      await slot.getByRole("button", { name: "Buscar terminal…" }).click();
      const search = page.getByRole("dialog", { name: "Buscar", exact: true });
      await expect(search).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(search).toHaveCount(0);
      const at = await box(slot);
      await page
        .getByRole("region", { name: "Fuera de las Mesas" })
        .locator(`[data-loose="${extra}"]`)
        .click();
      await expect(tiles).toHaveCount(4);
      await expect(slot).toHaveCount(0);
      const filled = await tile(3);
      expect(Math.round(filled.x)).toBe(Math.round(at.x));
      expect(Math.round(filled.y)).toBe(Math.round(at.y));
      await page.getByRole("button", { name: "Ocultar el carril" }).click();

      // Quitar closes the place it leaves; a slot closes with its own ×.
      await tiles
        .nth(3)
        .getByRole("button", { name: /^Quitar .* de la cuadrícula$/ })
        .click();
      await expect(tiles).toHaveCount(3);
      await expect(slot).toHaveCount(0);
      await presets.getByRole("button", { name: "Cuadrícula" }).click();
      await slot.getByRole("button", { name: "Cerrar el hueco" }).click();
      await expect(slot).toHaveCount(0);
      await expect
        .poll(async () => (await tile(2)).width)
        .toBeGreaterThan((await tile(0)).width * 1.8);
    } finally {
      await removeTerminals(request, [extra]);
    }

    // Folded, the rail leaves a strip that keeps its button and the layouts; the tiles take
    // the room, and opening it gives the room back.
    await expect(presets).toBeVisible();
    expect((await tile(0)).x).toBeLessThan(80);
    await noClippedControls(page);
    await page.screenshot({ path: `${EVIDENCE}/rail-folded-1280-dark.png` });
    await page.getByRole("button", { name: "Mostrar el carril" }).click();
    await expect.poll(async () => (await tile(0)).x).toBeGreaterThan(300);
  });

  test("Ampliar shows one tile, Quitar drops one and leaves its terminal running", async ({
    page,
    request,
  }) => {
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(3);

    await tiles.nth(2).getByRole("button", { name: "Ampliar" }).click();
    await expect(tiles).toHaveCount(1);
    await expect.poll(async () => (await currentMesa(page))?.max).toBe(ids[2]);
    await expect(tiles.first()).toHaveAttribute("aria-label", /frontend$/);
    await shoot(page, "max");
    await tiles.first().getByRole("button", { name: "Volver a la cuadrícula" }).click();
    await expect(tiles).toHaveCount(3);
    await expect.poll(async () => (await currentMesa(page))?.max).toBeUndefined();

    await tiles
      .nth(0)
      .getByRole("button", { name: /^Quitar .* de la cuadrícula$/ })
      .click();
    await expect(tiles).toHaveCount(2);
    await expect.poll(async () => (await currentMesa(page))?.ids).toEqual([ids[1], ids[2]]);
    const { terminals } = (await (await request.get("/api/terminals")).json()) as {
      terminals: { id: string; state: string }[];
    };
    expect(terminals.find((t) => t.id === ids[0])?.state).toBe("running");
  });

  test("the list adds a terminal from outside the Mesas, and a visit without ids gets the last grid back", async ({
    page,
  }) => {
    await page.goto(`/terminales?ids=${ids[0]}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(1);

    // Running terminals in no Mesa wait under «Fuera de las Mesas»; a click opens one here.
    const loose = page.getByRole("region", { name: "Fuera de las Mesas" });
    await expect(loose.locator(`[data-loose="${ids[2]}"]`)).toBeVisible();
    await expect(loose.locator(`[data-loose="${ids[0]}"]`)).toHaveCount(0);
    await shoot(page, "loose");
    await loose.locator(`[data-loose="${ids[2]}"]`).click();
    await expect(tiles).toHaveCount(2);
    await expect.poll(async () => (await currentMesa(page))?.ids).toEqual([ids[0], ids[2]]);

    await page.goto("/terminales");
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(1)).toHaveAttribute("aria-label", /frontend$/);
  });
});

// Read only: no terminal is launched; the width lives in this browser's storage.
test("a rail's inner edge sets its width, kept on reload, and a double click gives it back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/terminales");
  const rail = await openTree(page);
  const edge = page.getByRole("separator", { name: "Ancho del carril" });
  const width = async () => Math.round((await rail.boundingBox())?.width ?? 0);
  await expect.poll(width).toBe(340);
  const box = await edge.boundingBox();
  if (!box) throw new Error("no rail edge");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(width).toBe(460);
  await expect(rail.getByRole("region", { name: "Otros proyectos" })).toBeVisible();
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/rail-wide-1440-dark.png` });
  // Never past its cap: 45% of the window.
  await edge.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(Math.round(1440 * 0.45));
  await page.reload();
  await expect.poll(width).toBe(Math.round(1440 * 0.45));
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(width).toBe(Math.round(1100 * 0.45));
  await page.setViewportSize({ width: 1440, height: 900 });
  await edge.dblclick();
  await expect.poll(width).toBe(340);
  await page.reload();
  await expect.poll(width).toBe(340);
});
