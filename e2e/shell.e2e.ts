import { expect, test } from "@playwright/test";
import { noClippedControls } from "./helpers.ts";

const EVIDENCE = "data/evidence/shell";
// The pages with a bar of their own, which the app's top bar holds right of the main menu.
const BARS = [
  { to: "/terminales", title: "Mesa" },
  { to: "/agentes", title: "Agentes" },
  { to: "/consumo", title: "Consumo" },
  { to: "/tickets", title: "Tickets" },
];

for (const width of [390, 1024, 1280, 1440]) {
  test(`at ${width} each page's bar sits in the app's top bar and clips nothing`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const header = page.locator("body header").first();
    for (const bar of BARS) {
      await page.goto(bar.to);
      await expect(header.getByRole("heading", { level: 1, name: bar.title })).toBeVisible();
      // Measure Consumo once its report is in, so the bar holds everything it will hold.
      if (bar.to === "/consumo") await expect(page.getByText(/ llamadas$/)).toBeVisible();
      // The main menu names each page even where it shows only icons.
      await expect(
        page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Inicio" }),
      ).toBeVisible();
      await noClippedControls(page);
      // One row from md: the page keeps the height of the second bar it used to draw.
      if (width >= 1280) expect((await header.boundingBox())?.height).toBeLessThanOrEqual(45);
      await page.screenshot({ path: `${EVIDENCE}/${bar.title}-${width}.png` });
    }
  });
}

test("Inicio fits at 1024", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/");
  await expect(
    page.getByRole("main").getByRole("heading", { level: 1, name: "Ticket a ticket" }),
  ).toBeVisible();
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/home-1024.png` });
});

test("a lost event stream is said under the top bar, and the notice goes once it is back", async ({
  page,
}) => {
  // The lists are not polled: without the stream nothing on screen updates, so it must say so.
  await page.route("**/api/events", (route) => route.abort());
  await page.goto("/");
  const notice = page.getByRole("alert").filter({ hasText: "Sin conexión con el servidor" });
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await page.unroute("**/api/events");
  await expect(notice).toBeHidden({ timeout: 15_000 });
});

// A remote device with Jira disconnected reads where to reconnect in the top bar, not a link
// to a page the ingress refuses. The note must fit: the bar keeps one row from 1280.
for (const width of [1024, 1280]) {
  test(`at ${width} a remote device's Jira note fits the top bar`, async ({ page }) => {
    await page.route("**/api/access", (route) =>
      route.fulfill({ json: { remote: true, desktop: false } }),
    );
    await page.route("**/api/connections", (route) =>
      route.fulfill({
        json: {
          connections: [
            { provider: "atlassian", status: "not_connected", account: null, detail: null },
            { provider: "github", status: "connected", account: "me", detail: null },
          ],
        },
      }),
    );
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const header = page.locator("body header").first();
    const note = header.getByText("Reconéctalo desde el Mac");
    await expect(note).toBeVisible();
    await expect(header.locator('a[href="/auth/atlassian/start"]')).toHaveCount(0);
    const box = await note.boundingBox();
    const bar = await header.boundingBox();
    expect(box && bar && box.x + box.width <= bar.x + bar.width + 0.5).toBe(true);
    await noClippedControls(page);
    if (width >= 1280) expect(bar?.height).toBeLessThanOrEqual(45);
    await page.screenshot({ path: `${EVIDENCE}/remote-jira-${width}.png` });
  });
}
