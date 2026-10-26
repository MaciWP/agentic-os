import { expect, type Page, test } from "@playwright/test";
import { noClippedControls, skipWithoutJira } from "./helpers.ts";

// Real server, real Jira, real env provider. Nothing is launched or created here: the
// buttons spawn real harnesses, so the drive does that by hand. Evidence holds company data.
const EVIDENCE = "data/evidence/b3";

// A ticket of mine that already has an env, picked from live data (no keys in git).
async function ticketWithEnv(page: Page): Promise<string | null> {
  await skipWithoutJira(page.request);
  // A failure names its URL and how long it took, so a reset says which call it was.
  const read = async (url: string) => {
    const t0 = Date.now();
    try {
      return await page.request.get(url).then((r) => r.json());
    } catch (err) {
      throw new Error(`${url} failed after ${Date.now() - t0} ms: ${(err as Error).message}`);
    }
  };
  const [tickets, envs] = await Promise.all([read("/api/tickets"), read("/api/envs")]);
  const names = new Set(
    (envs.envs as { name: string; problem: string | null }[])
      .filter((e) => !e.problem)
      .map((e) => e.name),
  );
  const ticket = (tickets.tickets as { key: string }[]).find((t) => names.has(t.key.toLowerCase()));
  return ticket?.key ?? null;
}

test("a ticket with an env defaults to it; another location offers to create one", async ({
  page,
}) => {
  const key = await ticketWithEnv(page);
  test.skip(!key, "no ticket of mine has an env right now");
  await page.goto(`/tickets/${key}`);
  await page.getByText("Lanzar otro agente a mano").click();
  const panel = page.getByRole("region", { name: "Lanzar agente" });
  const where = panel.getByLabel("Dónde");
  await expect(where).toHaveValue(`env:${key?.toLowerCase()}`);
  for (const h of ["Shell", "Claude", "Codex", "Grok"]) {
    await expect(panel.getByRole("button", { name: h, exact: true })).toBeVisible();
  }

  await where.selectOption("new");
  await expect(panel.getByLabel("Nombre del entorno")).toHaveValue(key?.toLowerCase() ?? "");
  await expect(panel.getByRole("group", { name: `Repos (rama feature/${key})` })).toBeVisible();
  const create = panel.getByRole("button", { name: "Crear entorno" });
  await expect(create).toBeEnabled();
  for (const box of await panel.getByRole("checkbox").all()) await box.uncheck();
  await expect(create).toBeDisabled();
});

for (const scheme of ["dark"] as const) {
  for (const width of [1280, 375]) {
    test(`launch panel ${width} ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height: width > 400 ? 800 : 812 },
      });
      const page = await context.newPage();
      const key = await ticketWithEnv(page);
      test.skip(!key, "no ticket of mine has an env right now");
      await page.goto(`/tickets/${key}`);
      await page.getByText("Lanzar otro agente a mano").click();
      const panel = page.getByRole("region", { name: "Lanzar agente" });
      await expect(panel.getByRole("button", { name: "Claude", exact: true })).toBeVisible();
      await noClippedControls(page);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${EVIDENCE}/launch-${width}-${scheme}.png` });
      await panel.getByLabel("Dónde").selectOption("new");
      await noClippedControls(page);
      await context.close();
    });
  }
}

// A picked model and effort reach the server as the launch body; argvFor turns them into flags
// (terminals.test.ts). The POST is answered here, so no real Claude starts.
test("a picked model launches only its CLI and sends the model and effort", async ({ page }) => {
  const key = "ABC-9";
  await page.route(/\/api\/tickets\/ABC-9$/, (route) =>
    route.fulfill({
      json: {
        key,
        summary: "Selector de modelo",
        status: { id: "3", name: "In Progress", category: "indeterminate" },
        issuetype: "Task",
        assignee: null,
        parent: null,
        priority: null,
        labels: [],
        points: null,
        size: null,
        reviewers: [],
        updated: "2026-10-07T08:00:00Z",
        url: `https://jira.example.test/browse/${key}`,
        descriptionAdf: null,
        descriptionMd: "",
        acceptanceCriteria: [],
      },
    }),
  );
  await page.route("**/api/envs", (route) =>
    route.fulfill({ json: { configured: false, envs: [], repos: [] } }),
  );
  const bodies: unknown[] = [];
  await page.route("**/api/terminals", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "launch_rejected" } });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/tickets/${key}`);
  await page.getByText("Lanzar otro agente a mano").click();
  const panel = page.getByRole("region", { name: "Lanzar agente" });
  const pick = panel.getByLabel("Modelo y esfuerzo");
  await expect(pick).toHaveValue("");
  await pick.selectOption({ label: "Sonnet · medium" });
  for (const h of ["Shell", "Codex", "Grok"])
    await expect(panel.getByRole("button", { name: h, exact: true })).toBeDisabled();
  await expect(panel.getByText("Con un modelo elegido solo se lanza Claude.")).toBeVisible();
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/launch-model-1280-dark.png` });

  await panel.getByRole("button", { name: "Claude", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({
    harness: "claude",
    ticket: key,
    model: "sonnet",
    effort: "medium",
  });

  await pick.selectOption("");
  await expect(panel.getByRole("button", { name: "Codex", exact: true })).toBeEnabled();
});
