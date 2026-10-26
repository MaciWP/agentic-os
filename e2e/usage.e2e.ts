import { expect, test } from "@playwright/test";
import { noClippedControls } from "./helpers.ts";

const EVIDENCE = "data/evidence/usage";
// The report reads every transcript on disk: a week took 6.9 s at load 30 (2026-10-08), past an
// assertion's 5 s. A step that asks for a new range waits this long for it.
const REPORT_MS = 30_000;

// Consumo by quota week: the period on top drives every section under it and rides in the URL,
// as does a ticket picked from the ledger and the open topic tab. Real transcripts, so the test
// reads whatever the week holds.
for (const width of [1280, 1440]) {
  test(`at ${width} the week drives every section, and a ticket rides in the URL`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/consumo");
    await expect(page.getByRole("region", { name: "Gasto en este periodo" })).toBeVisible({
      timeout: REPORT_MS,
    });
    // No range of days of its own any more: the period above is the only clock.
    await expect(page.getByRole("button", { name: "30 días" })).toHaveCount(0);
    await expect(page.getByLabel("Desde")).toHaveCount(0);

    const ledger = page.getByRole("navigation", { name: "Tickets" });
    const all = ledger.getByRole("button").filter({ hasText: "Todos los tickets" });
    await expect(all).toHaveAttribute("aria-current", "true");
    const rows = ledger.getByRole("button");
    if ((await rows.count()) > 1) {
      await rows.nth(1).click();
      await expect(page).toHaveURL(/ticket=/);
      await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
      await all.click();
      await expect(page).not.toHaveURL(/ticket=/);
    }

    // One tab per topic under the chart; each shows its own panel and rides in the URL.
    const tabs = page.getByRole("tablist", { name: "Temas de consumo" });
    const open = async (name: string) => {
      await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
      const panel = page.getByRole("tabpanel");
      await expect(panel).toBeVisible();
      return panel;
    };
    await expect(tabs.getByRole("tab")).toHaveText([
      /^Gasto y tickets/,
      /^Modelos/,
      /^Log Pose/,
      /^Router y skills/,
      /^Salud/,
      /^Inventario/,
    ]);
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(/^Gasto y tickets/);
    await expect(page.getByRole("region", { name: "Gasto en este periodo" })).toBeVisible();

    const models = await open("Modelos");
    await expect(page).toHaveURL(/tab=modelos/);
    await expect(models.getByRole("region", { name: "Quién usa cada modelo" })).toBeVisible();
    await expect(
      models.getByRole("region", { name: "Gasto por nivel de effort", exact: true }),
    ).toBeVisible();
    // The reason behind a figure is one hover or one Tab away, never a line under it.
    const why = models.getByRole("button", { name: /^Para qué: / }).first();
    await why.focus();
    await expect(page.getByRole("tooltip")).toContainText("Para qué:");
    await page.screenshot({ path: `${EVIDENCE}/tab-modelos-${width}.png` });

    // With mod runs in the week, Log Pose answers whether its effort, gauge and fixes fit. The
    // judge's button shows its price and is never pressed here: a pass is a real Sonnet spend.
    const pose = await open("Log Pose");
    await expect(pose.getByRole("region", { name: "Log Pose", exact: true })).toBeVisible();
    if ((await pose.getByText(/el router sigue con el hook/).count()) === 0) {
      for (const name of [
        "¿Elige bien el effort?",
        "Señales por nivel",
        "¿Pide bien el advisor?",
        "Dictado",
      ])
        await expect(pose.getByRole("region", { name, exact: true })).toBeVisible();
      await expect(
        pose.getByRole("button", {
          name: /^(Juzgar este periodo|Repetir)( · ≈.+ \$)?$|^Juzgando…$/,
        }),
      ).toBeVisible();
      // The page scrolls inside its own box: a tall window fits the whole panel in one shot.
      await page.setViewportSize({ width, height: 4000 });
      await pose.screenshot({ path: `${EVIDENCE}/logpose-${width}.png` });
      await page.setViewportSize({ width, height: 900 });
    }
    const router = await open("Router y skills");
    await expect(
      router.getByRole("region", { name: "Router de skills", exact: true }),
    ).toBeVisible();

    const health = await open("Salud");
    const vitals = health.getByRole("region", { name: "Salud en este periodo" });
    await expect(vitals).toBeVisible();
    await expect(vitals.getByText(/^Roturas de caché/)).toBeVisible();
    await vitals.screenshot({ path: `${EVIDENCE}/health-${width}.png` });
    const hooks = health.getByRole("region", { name: "Hooks", exact: true });
    await expect(
      hooks
        .getByRole("list", { name: "Hooks" })
        .or(hooks.getByText("Ningún hook en este periodo.")),
    ).toBeVisible();
    await hooks.getByRole("button", { name: "Ver como tabla" }).click();
    await expect(
      hooks
        .getByRole("table", { name: "Hooks" })
        .or(hooks.getByText("Ningún hook en este periodo.")),
    ).toBeVisible();
    // The inventory is a tab with every count panel open.
    const inventory = await open("Inventario");
    for (const name of ["Skills", "Subagentes", "Comandos", "Herramientas", "Servidores MCP"])
      await expect(inventory.getByRole("region", { name, exact: true })).toBeVisible();
    // A reload keeps the tab.
    await page.reload();
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(/^Inventario/, {
      timeout: REPORT_MS,
    });
    // A long panel unfolds in place, with no scroll of its own.
    const more = page.getByRole("button", { name: /^Ver todo \(\d+\)$/ }).first();
    if ((await more.count()) > 0) {
      await more.click();
      await expect(page.getByRole("button", { name: "Ver menos" }).first()).toBeVisible();
    }
    await noClippedControls(page);
    await page.screenshot({ path: `${EVIDENCE}/week-${width}.png`, fullPage: true });

    // The week before: the URL keeps it, and the sections below read it too. The call count
    // lives with the sources, in Salud.
    await open("Salud");
    const calls = await page.getByText(/ llamadas$/).textContent();
    await page.getByRole("button", { name: "Semana anterior" }).click();
    await expect(page).toHaveURL(/offset=1/);
    // Moving the period keeps the open tab.
    await expect(page).toHaveURL(/tab=salud/);
    await expect(page.getByText(/ llamadas$/)).not.toHaveText(calls ?? "", { timeout: REPORT_MS });
  });
}

// An old link's range is ignored: it opens on the current week with its ticket, and the first
// move writes a clean URL.
test("an old link's dates are dropped; the ticket stays", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/consumo?all=true&from=2026-01-01&ticket=none");
  await expect(page.getByRole("region", { name: "Gasto en este periodo" })).toBeVisible({
    timeout: REPORT_MS,
  });
  await expect(
    page.getByRole("region", { name: /Semana de cuota/ }).getByText(/en curso/),
  ).toBeVisible({
    timeout: REPORT_MS,
  });
  await expect(page.getByRole("article", { name: "Sin ticket" })).toBeVisible();
  await page.getByRole("button", { name: "Semana anterior" }).click();
  await expect(page).toHaveURL(/offset=1/);
  await expect(page).not.toHaveURL(/all=true|from=/);
  await expect(page).toHaveURL(/ticket=none/);
});

// The quota week on top: it moves a week back and forth, switches to months, filters and
// colours without leaving the page, and reads as a table too.
test("the period panel moves through weeks and months and reads as a table", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/consumo");
  const panel = page.getByRole("region", { name: /Semana de cuota/ });
  await expect(panel.getByText(/Gastado hasta ahora/)).toBeVisible({ timeout: REPORT_MS });
  await expect(panel.getByText(/en curso/)).toBeVisible();
  const next = panel.getByRole("button", { name: "Semana siguiente" });
  await expect(next).toBeDisabled();
  await panel.getByRole("button", { name: "Semana anterior" }).click();
  await expect(panel.getByText(/cerrado/)).toBeVisible({ timeout: REPORT_MS });
  await expect(next).toBeEnabled();
  await panel.getByRole("button", { name: "Volver a la actual" }).click();
  await expect(panel.getByText(/en curso/)).toBeVisible({ timeout: REPORT_MS });

  await panel.getByRole("button", { name: "Sin ticket" }).click();
  await expect(panel.getByRole("button", { name: "Sin ticket" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await panel.getByLabel("Colorear por").selectOption("model");
  await panel.getByRole("button", { name: "Tokens" }).click();
  await panel.getByRole("button", { name: "Ver como tabla" }).click();
  await expect(
    panel
      .getByRole("table", { name: "Gasto por serie" })
      .or(panel.getByText("Nada gastado en este periodo con estos filtros.")),
  ).toBeVisible();

  await panel.getByRole("button", { name: "Mes", exact: true }).click();
  await expect(page.getByRole("region", { name: /^Mes/ })).toBeVisible({ timeout: REPORT_MS });
  await expect(page.getByRole("button", { name: "Mes anterior" })).toBeVisible();
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/period-1280.png`, fullPage: true });
});
