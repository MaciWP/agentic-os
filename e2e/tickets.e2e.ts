import { expect, test } from "@playwright/test";
import { noClippedControls, skipWithoutJira } from "./helpers.ts";

// Real server, real Jira: no fakes. Screenshots hold company data, so they go to data/evidence.
const EVIDENCE = "data/evidence/b2";
const WORKFLOW = ["QUÉ", "En curso", "In Product Review", "Release Ready"];

test("lists my real tickets grouped by status and opens the detail", async ({ page }) => {
  await skipWithoutJira(page.request);
  await page.goto("/tickets");
  const rows = page.locator("[data-ticket]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);

  const groups = await page
    .locator("section[aria-label]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  const known = groups.filter((g) => WORKFLOW.includes(g));
  expect(known, "known groups keep the workflow order").toEqual(
    WORKFLOW.filter((s) => known.includes(s)),
  );

  const key = (await rows.first().getAttribute("data-ticket")) ?? "";
  await rows.first().click();
  await expect(page).toHaveURL(new RegExp(`/tickets/${key}$`));
  await expect(page.locator("#ticket-title")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Criterios de aceptación/ })).toBeVisible();

  await page.reload();
  await expect(page.locator("#ticket-title")).toBeVisible();
  await expect(page.locator(`[data-ticket="${key}"]`)).toHaveAttribute("aria-current", "page");
});

for (const scheme of ["dark"] as const) {
  for (const width of [1280, 375]) {
    test(`screenshots ${width} ${scheme}`, async ({ browser, request }) => {
      await skipWithoutJira(request);
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height: width > 400 ? 800 : 812 },
      });
      const page = await context.newPage();
      await page.goto("/tickets");
      const first = page.locator("[data-ticket]").first();
      await expect(first).toBeVisible();
      await noClippedControls(page);
      await page.screenshot({ path: `${EVIDENCE}/list-${width}-${scheme}.png` });

      // Prefer a ticket with ACs so the screenshot shows the checklist.
      const key = (await first.getAttribute("data-ticket")) ?? "";
      await page.goto(`/tickets/${process.env.AOS_SHOT_KEY ?? key}`);
      await expect(page.locator("#ticket-title")).toBeVisible();
      // At md+ the list stays beside the detail: wait for it too, not its skeleton.
      if (width >= 768) await expect(page.locator("[data-ticket]").first()).toBeVisible();
      await noClippedControls(page);
      await page.screenshot({ path: `${EVIDENCE}/detail-${width}-${scheme}.png`, fullPage: true });
      await context.close();
    });
  }
}
