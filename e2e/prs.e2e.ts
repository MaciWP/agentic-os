import { expect, type Locator, type Page, test } from "@playwright/test";
import { noClippedControls, railShows } from "./helpers.ts";

const EVIDENCE = "data/evidence/b3";

// "Revisar" opens the review launcher in a popover. Nothing is launched: it only opens.
async function opensLauncher(page: Page, review: Locator, shot: string) {
  await expect(review).toHaveAttribute("aria-expanded", "false");
  await review.click();
  await expect(review).toHaveAttribute("aria-expanded", "true");
  const launcher = page.getByRole("dialog");
  await expect(launcher.getByLabel("Prompt guardado")).toBeVisible();
  for (const name of ["Claude", "Codex", "Grok"]) {
    await expect(launcher.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  // The review runs with the agent's usual permissions; the launcher says it is not read-only.
  await expect(launcher.getByText(/no impone un aislamiento de solo lectura/)).toBeVisible();
  // The popover fades in; the evidence waits for it to settle.
  await expect(launcher).toHaveCSS("opacity", "1");
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/${shot}.png` });
  await page.keyboard.press("Escape");
  await expect(review).toHaveAttribute("aria-expanded", "false");
}

// Real server, real GitHub (read-only): every PR the Mesa's tree lists can be reviewed.
test("each PR in the Mesa's tree links to GitHub and Revisar opens its launcher", async ({
  page,
}) => {
  const listed = (await (await page.request.get("/api/github/prs")).json()) as { prs?: unknown[] };
  test.skip(!listed.prs?.length, "GitHub lists no PR for the configured repos");
  await page.setViewportSize({ width: 1280, height: 800 });
  await railShows(page, "prs");
  await page.goto("/terminales");
  // The PRs have their own tab under the Mesas.
  const rail = page
    .getByRole("region", { name: "Mesas y proyectos" })
    .getByRole("region", { name: "PRs", exact: true });
  await expect(rail.first()).toBeAttached();
  await expect(rail.getByRole("alert")).toHaveCount(0);
  const review = rail.getByRole("button", { name: /^Revisar \S+#\d+$/ });
  await expect(review).toHaveCount(listed.prs?.length ?? 0);
  const link = rail
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: /^Revisar / }) })
    .first()
    .getByRole("link");
  await expect(link).toHaveAttribute("href", /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
  await expect(link).toHaveAttribute("target", "_blank");
  await opensLauncher(page, review.first(), "prs-rail-1280");
});

// Inicio holds only the PRs asking for you or yours. GitHub may list none, so one is stubbed
// in the browser; everything else is real.
test("a PR asking for review sits in Inicio with Revisar and its GitHub link", async ({ page }) => {
  await page.route("**/api/github/prs*", (route) =>
    route.fulfill({
      json: {
        prs: [
          {
            repo: "acme/api",
            number: 4,
            title: "Retry the webhook",
            url: "https://github.com/acme/api/pull/4",
            author: "ana",
            draft: false,
            updatedAt: new Date().toISOString(),
            kind: "review",
          },
        ],
        errors: [],
        repos: ["acme/api"],
      },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Ticket a ticket" })).toBeVisible();
  // A review request outranks a waiting agent, so it shows without opening "Ver las N".
  const review = page.getByRole("button", { name: "Revisar acme/api#4" });
  await expect(review).toBeVisible();
  const link = page.getByRole("link", { name: "Abrir en GitHub: api#4" });
  await expect(link).toHaveAttribute("href", "https://github.com/acme/api/pull/4");
  await opensLauncher(page, review, "prs-inicio-1280");
});
