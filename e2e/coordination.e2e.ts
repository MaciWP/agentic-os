import { expect, test } from "@playwright/test";
import { noClippedControls, origin } from "./helpers.ts";

const headers = { origin, "content-type": "application/json" };
// No real harness is launched by this suite. The consultation model boundary is a fixture;
// API/runner unit tests cover the durable transition and native pipe adapter separately.
for (const width of [1280, 390])
  test(`consultation approval, cancellation and results at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let q: Record<string, unknown> | null = null;
    let approved = 0;
    const attempts = ["claude", "codex"].map((harness, i) => ({
      id: `attempt-${i}`,
      participant: { harness, model: `fixture-${harness}` },
      kind: "opinion",
      state: "queued",
      result: null,
      usage: null,
      error: null,
      startedAt: null,
      endedAt: null,
    }));
    await page.route("**/api/coordination**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/capabilities"))
        return route.fulfill({
          json: {
            adapters: ["claude", "codex", "grok"].map((harness) => ({
              harness,
              available: harness !== "grok",
              reason: "Not verified",
            })),
          },
        });
      if (path.endsWith("/consultations") && route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        q = {
          id: "query",
          author: "user",
          createdAt: new Date().toISOString(),
          input,
          contextText: "",
          state: "pending",
          approvedAt: null,
          fingerprint: "abc123",
          snapshot: "/fixture/snapshot",
          source: "/fixture",
          error: null,
          attempts,
        };
        return route.fulfill({ status: 201, json: q });
      }
      if (path.endsWith("/approve")) {
        approved++;
        if (q) {
          q.state = "running";
          q.attempts = attempts.map((a) => ({ ...a, state: "running" }));
        }
        return route.fulfill({ json: q });
      }
      if (path.endsWith("/cancel")) {
        if (q) {
          q.state = "cancelled";
          q.attempts = attempts.map((a, i) => ({
            ...a,
            state: i === 0 ? "succeeded" : "cancelled",
            result: i === 0 ? "The API needs request validation." : null,
          }));
        }
        return route.fulfill({ json: q });
      }
      if (path.endsWith("/consultations/query")) return route.fulfill({ json: q });
      return route.fulfill({
        json: {
          revision: approved,
          messages: [],
          reservations: [],
          agents: [],
          audit: [],
          consultations: q ? [{ ...q, prompt: (q.input as { prompt: string }).prompt }] : [],
        },
      });
    });
    await page.goto(`${origin}/agentes?s=consultas`);
    await expect(
      page
        .getByRole("navigation", { name: "Secciones de Agentes" })
        .locator('[aria-current="page"]'),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Nueva consulta" }).click();
    const project = page.getByRole("combobox", { name: "Proyecto", exact: true });
    await expect(project.locator("option").nth(1)).toBeAttached();
    await project.selectOption({ index: 1 });
    await page.getByLabel("Pregunta", { exact: true }).fill("Review the API");
    await page.getByLabel("Modelo de Claude").fill("fixture-claude");
    await page.getByLabel("Modelo de Codex").fill("fixture-codex");
    await page.getByRole("button", { name: "Preparar lote", exact: true }).click();
    await expect(page.getByRole("button", { name: "Aprobar y lanzar 2 respuestas" })).toBeVisible();
    expect(approved).toBe(0);
    await noClippedControls(page);
    await page.screenshot({ path: `data/evidence/coordination/approval-${width}.png` });
    await page.getByRole("button", { name: "Aprobar y lanzar 2 respuestas" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => approved).toBe(1);
    await page.getByRole("button", { name: "Cancelar consulta" }).click();
    await expect(page.getByText("The API needs request validation.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Preparar síntesis", exact: true }),
    ).toBeVisible();
    await noClippedControls(page);
  });

test("real isolated API reservation appears in Agents and releases with confirmation", async ({
  page,
  request,
}) => {
  const terminals = await (await request.get("/api/terminals")).json();
  const location = terminals.locations.find((l: { id: string }) => l.id.startsWith("repo:"))?.id;
  expect(location).toBeTruthy();
  const acquired = await request.post("/api/coordination/reservations", {
    headers,
    data: {
      location,
      paths: [`aos-e2e-${crypto.randomUUID()}.ts`],
      reason: "Coordination browser test",
    },
  });
  expect(acquired.ok()).toBe(true);
  const [reservation] = await acquired.json();
  try {
    await page.goto(`${origin}/agentes?s=reservas`);
    const row = page.getByRole("listitem").filter({ hasText: reservation.path });
    await expect(row).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Liberar" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await request.delete(`/api/coordination/reservations/${reservation.id}`, { headers, data: {} });
  }
});
