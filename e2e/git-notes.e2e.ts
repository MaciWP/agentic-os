import { expect, test } from "@playwright/test";
import {
  appNode,
  currentMesa,
  noClippedControls,
  projectsOf,
  resetWorkspace,
  rowPlus,
} from "./helpers.ts";

// Notes on the app checkout's diff: they live in the page's storage, so the checkout itself is
// never touched. Evidence holds company data.
const EVIDENCE = "data/evidence/notes";

test.beforeEach(async ({ request }) => resetWorkspace(request));

test("a note on a line or a range stays after a reload, counts on its file and waits to be sent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/proyectos?node=app&tab=git");
  await expect.poll(async () => (await currentMesa(page))?.node).toBe("app");
  const p = await projectsOf(page);
  const { name: appName, location } = await appNode(page);
  await (await rowPlus(page, location, appName, "Git")).click();
  await expect
    .poll(async () => (await currentMesa(page))?.ids)
    .toContain(`git:${encodeURIComponent(p.app.location)}`);
  const tile = page.getByRole("region", { name: `Git de ${appName}` });
  const rows = tile.locator("[data-pick]");
  await expect(rows.first()).toBeVisible();

  // The first changed file whose diff has at least three line numbers.
  const gutter = tile.getByRole("button", { name: /^Nota en la línea / });
  let path = "";
  for (let i = 0; i < Math.min(await rows.count(), 8) && !path; i++) {
    const label = (await rows.nth(i).getAttribute("aria-label")) ?? "";
    const loaded = page.waitForResponse((r) => r.url().includes("/api/git/diff?") && r.ok());
    await rows.nth(i).click();
    await loaded;
    await expect(tile.getByRole("region", { name: /^Diff de / })).toBeVisible();
    if ((await gutter.count()) >= 3) path = label.slice(0, label.lastIndexOf(", "));
  }
  test.skip(!path, "no changed file with a text diff in this checkout");
  const row = tile.locator(`[data-pick][aria-label^="${path}, "]`);

  // A click opens the editor on that line; Shift+click on another line of its hunk makes a range.
  await gutter.nth(0).click();
  const editor = tile.getByRole("textbox", { name: "Texto de la nota" });
  await expect(editor).toBeFocused();
  await expect(tile.getByText(/^Nueva nota · línea \d+/)).toBeVisible();
  // A context line has two numbers, an added or removed one one: the third button is on another
  // line of the first hunk, which holds at least three context lines.
  await gutter.nth(2).click({ modifiers: ["Shift"] });
  await expect(tile.getByText(/^Nueva nota · líneas \d+–\d+/)).toBeVisible();
  await tile
    .getByRole("group", { name: "Tipo de nota" })
    .getByRole("button", { name: "pregunta" })
    .click();
  await tile
    .getByRole("group", { name: "Frases rápidas" })
    .getByRole("button", { name: /^Añade un test/ })
    .click();
  await expect(editor).toHaveValue("Añade un test que lo cubra.");
  await editor.press("ControlOrMeta+Enter");
  await expect(editor).toHaveCount(0);

  const card = tile.locator("[data-note]");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("pregunta");
  await expect(card).toContainText(/líneas \d+–\d+/);
  await expect(card).toContainText("Añade un test que lo cubra.");
  const bar = tile.getByRole("region", { name: "Notas del diff" });
  await expect(bar).toContainText("1 nota");
  await expect(bar).toContainText("en 1 fichero");
  await expect(row).toHaveAttribute("aria-label", /, 1 nota sin enviar$/);
  // The throwaway server runs no agent in this checkout: the bar says why and cannot send.
  await expect(bar.getByText("no hay ningún agente en marcha en este checkout")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Enviar 1" })).toBeDisabled();
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/note-saved-1280-dark.png` });

  // A reload keeps it: the badge on the file and the card in its diff.
  await page.reload();
  await expect(row).toHaveAttribute("aria-label", /, 1 nota sin enviar$/);
  await row.click();
  await expect(tile.locator("[data-note]")).toHaveCount(1);
  await expect(tile.locator("[data-note]")).toContainText("Añade un test que lo cubra.");

  // Side by side, a context line sits on both halves of its row: the note shows once.
  await tile
    .getByRole("group", { name: "Vista del diff" })
    .getByRole("button", { name: "Lado a lado" })
    .click();
  await expect(tile.locator("[data-note]")).toHaveCount(1);
  await noClippedControls(page);

  // Deleting it clears the badge and the bar.
  await tile.getByRole("button", { name: /^Borrar la nota de / }).click();
  await expect(tile.locator("[data-note]")).toHaveCount(0);
  await expect(tile.getByRole("region", { name: "Notas del diff" })).toHaveCount(0);
  await expect(row).not.toHaveAttribute("aria-label", /nota/);
});
