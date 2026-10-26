import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { noClippedControls, origin, removeTerminals } from "./helpers.ts";

// A terminal's name and "Abrir carpeta". The name is set from the window's header and then
// names the terminal on the Mesa tile, in the Mesa's picker and in the palette.
// "Abrir carpeta" runs the e2e profile's fake editor, which only records its arguments in the
// log named by AOS_E2E_EDITOR_LOG; without that variable the click is never made.
// Only shells at repo:contract and repo:frontend are launched, stopped and removed again.
const EVIDENCE = "data/evidence/L2";
const EDITOR_LOG = process.env.AOS_E2E_EDITOR_LOG;
const headers = { origin, "content-type": "application/json" };
const NAME = "Pruebas API";

type Listed = { id: string; name: string | null; cwd: string };

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

test.describe("terminal name", () => {
  const ids: string[] = [];
  const listed = async (page: Page, id: string) => {
    const { terminals } = (await (await page.request.get("/api/terminals")).json()) as {
      terminals: Listed[];
    };
    return terminals.find((t) => t.id === id);
  };

  test.beforeAll(async ({ request }) => {
    for (const location of ["repo:contract", "repo:frontend"]) {
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

  test("the header renames a terminal with Enter; Esc keeps the old name", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminal/${ids[0]}`);
    const header = page
      .locator("header")
      .filter({ has: page.getByRole("button", { name: "Renombrar" }) });
    await expect(header).toContainText("Shell");
    await header.getByRole("button", { name: "Renombrar" }).click();
    const field = page.getByRole("textbox", { name: "Nombre de la terminal" });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("maxlength", "40");
    await field.fill(`  ${NAME}  `);
    await shoot(page, "editing");
    await field.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(header).toContainText(NAME);
    await expect.poll(async () => (await listed(page, ids[0] ?? ""))?.name).toBe(NAME);
    await expect(page).toHaveTitle(new RegExp(`^${NAME} · `));

    // Esc leaves the name alone and sends nothing.
    let sent = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/name")) sent++;
    });
    await header.getByRole("button", { name: "Renombrar" }).click();
    await field.fill("otro nombre");
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(sent).toBe(0);
    await expect(header).toContainText(NAME);
    await shoot(page, "named");
  });

  test("the name follows the terminal to the Mesa, its list and the palette", async ({ page }) => {
    await page.request.post(`/api/terminals/${ids[0]}/name`, { headers, data: { name: NAME } });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tile = page.getByRole("region", { name: new RegExp(`^${NAME} en `) });
    await expect(tile).toHaveCount(1);
    await expect(page.locator("section[aria-label^='Shell en ']")).toHaveCount(1);
    // The name is shown whole: the cwd gives way first, and on the narrower tiles beside the
    // rail the live state shrinks to its dot.
    const chip = tile.locator('header [data-part="title"]');
    await expect(chip).toHaveText(NAME);
    const whole = () => chip.evaluate((el) => el.scrollWidth <= el.clientWidth);
    await expect.poll(whole).toBe(true);

    // A Mesa still called «Mesa N» goes by the name of a terminal in it.
    const rail = page.getByRole("region", { name: "Mesas y proyectos" });
    await expect(rail.getByRole("tab", { selected: true })).toContainText(NAME);
    await expect.poll(whole).toBe(true);
    await shoot(page, "mesa");

    await page.keyboard.press("Meta+K");
    const dialog = page.getByRole("dialog", { name: "Buscar", exact: true });
    await page.keyboard.type("pruebas api");
    // The open Mesa goes by that name too, so its commands match it: one terminal among them.
    const named = dialog.getByRole("option").filter({ hasNotText: "la Mesa" });
    await expect(named).toHaveCount(1);
    await expect(named).toContainText(NAME);
    // The kind still finds it.
    await dialog.getByRole("combobox").fill("shell contract");
    await expect(dialog.getByRole("option").filter({ hasText: NAME })).toHaveCount(1);
    await page.keyboard.press("Escape");
  });

  test("Abrir carpeta hands the terminal's own folder to the editor", async ({ page }) => {
    test.skip(!EDITOR_LOG, "AOS_E2E_EDITOR_LOG names the fake editor's log");
    const log = EDITOR_LOG ?? "";
    writeFileSync(log, "");
    const id = ids[1] ?? "";
    const cwd = (await listed(page, id))?.cwd;
    expect(cwd).toBeTruthy();
    await page.goto(`/terminal/${id}`);
    const open = page.getByRole("button", { name: "Abrir carpeta" });
    await expect(open).toBeEnabled();
    await expect(open).toHaveAttribute("title", `Abrir ${cwd} en el editor`);
    await open.click();
    await expect.poll(() => readFileSync(log, "utf8"), { timeout: 5000 }).toBe(`${cwd}\n`);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a failed Abrir carpeta says why in words and the notice closes", async ({ page }) => {
    let clicks = 0;
    await page.route("**/open-folder", (route) => {
      clicks++;
      return route.fulfill({ status: 409, json: { error: "folder_gone" } });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminal/${ids[1]}`);
    await page.getByRole("button", { name: "Abrir carpeta" }).click();
    const notice = page.getByRole("alert");
    await expect(notice).toHaveText("La carpeta de esta terminal ya no existe.");
    expect(clicks).toBe(1);
    await shoot(page, "notice");
    await notice.getByRole("button", { name: "Cerrar aviso" }).click();
    await expect(notice).toHaveCount(0);
  });
});
