import { expect, test } from "@playwright/test";
import { terminal } from "../web/features/terminals/test-fixtures.ts";
import { origin, removeTerminals, resetWorkspace, waitReady } from "./helpers.ts";

// The work bar and the objective chip on the real server: the seeded «Minar rituales» button
// dragged onto a shell is refused with its reason and nothing is sent; a goal is created, set
// and closed from the tile's chip. Inicio's goal lane reads a stubbed agent, since an idle
// shell is not in Inicio. Only one shell at repo:contract is launched and removed again.
const EVIDENCE = "data/evidence/work-bar";
const headers = { origin, "content-type": "application/json" };

test.describe("work bar", () => {
  const ids: string[] = [];

  test.beforeAll(async ({ request }) => {
    const res = await request.post("/api/terminals", {
      headers,
      data: { harness: "shell", location: "repo:contract" },
    });
    expect(res.ok(), await res.text()).toBe(true);
    ids.push(((await res.json()) as { terminal: { id: string } }).terminal.id);
  });

  test.afterAll(async ({ request }) => {
    await removeTerminals(request, ids);
  });

  test("a bar button dropped on a shell says why it is refused; the chip sets and closes a goal", async ({
    page,
    request,
  }) => {
    await resetWorkspace(request);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tile = page.locator("section[aria-label^='Shell en ']").first();
    await waitReady(tile);

    const bar = page.getByRole("list", { name: "Barra de trabajo" });
    const button = bar.getByRole("listitem").filter({ hasText: "Minar rituales" });
    await expect(button).toBeVisible();
    // A double click opens what the ritual sends, to read and edit it before dragging it.
    await button.getByRole("button").dblclick();
    const editor = page.getByRole("dialog", { name: "Ritual «Minar rituales»" });
    const text = editor.getByRole("textbox", { name: "Lo que se envía al agente" });
    await expect(text).toHaveValue(/mine-rituals\.ts/);
    await expect(editor.getByRole("button", { name: "Guardar" })).toBeDisabled();
    await editor.getByRole("textbox", { name: "Nombre del botón" }).fill("Minar ya");
    await editor.getByRole("button", { name: "{{branch}}" }).click();
    await expect(text).toHaveValue(/\{\{branch\}\}$/);
    await page.screenshot({ path: `${EVIDENCE}/ritual-editor-1280.png` });
    await editor.getByRole("button", { name: "Guardar" }).click();
    await expect(editor).toBeHidden();
    const renamed = bar.getByRole("listitem").filter({ hasText: "Minar ya" });
    await expect(renamed).toBeVisible();
    // Undone the same way, so the throwaway server keeps its seeded prompt.
    await renamed.getByRole("button").dblclick();
    const again = page.getByRole("dialog", { name: "Ritual «Minar ya»" });
    await again.getByRole("textbox", { name: "Nombre del botón" }).fill("");
    const undo = again.getByRole("textbox", { name: "Lo que se envía al agente" });
    await undo.fill((await undo.inputValue()).replace(/\{\{branch\}\}$/, ""));
    await again.getByRole("button", { name: "Guardar" }).click();
    await expect(button).toBeVisible();
    const brought: unknown[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/bring")) brought.push(r.postDataJSON());
    });
    await button.dragTo(tile);
    await expect(page.getByRole("status", { name: /^No se ha llevado/ })).toHaveAttribute(
      "title",
      /No se ha llevado «Minar rituales» a .*: solo un agente Claude o Codex recibe botones\./,
    );
    expect(brought).toEqual([]);
    await page.screenshot({ path: `${EVIDENCE}/bar-refused-1280.png` });

    const title = `e2e objetivo ${Date.now()}`;
    await tile.getByRole("button", { name: "Objetivo: Sin objetivo" }).click();
    const field = page.getByRole("textbox", { name: "Nuevo objetivo" });
    await field.fill(title);
    await field.press("Enter");
    const chip = tile.getByRole("button", { name: `Objetivo: ${title}` });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByRole("button", { name: `Cerrar el objetivo ${title}` })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/chip-1280.png`, animations: "disabled" });
    await page.getByRole("button", { name: `Cerrar el objetivo ${title}` }).click();
    // Closed, it leaves the list; the terminal keeps it until it is set to something else.
    await chip.click();
    await expect(page.getByRole("button", { name: `Cerrar el objetivo ${title}` })).toHaveCount(0);
    await page.getByRole("button", { name: "El del lanzamiento" }).click();
    await expect(tile.getByRole("button", { name: "Objetivo: Sin objetivo" })).toBeVisible();
  });

  test("Inicio shows a goal as a lane with its agents and a link to its cost", async ({ page }) => {
    const goal = { kind: "goal" as const, id: 999, title: "Refactor del host", closedAt: null };
    await page.route(
      (url) => url.pathname === "/api/terminals",
      (route) =>
        route.fulfill({
          json: {
            terminals: [
              terminal({
                id: "stub-agent",
                harness: "claude",
                ticket: null,
                objective: goal,
                agent: { sessionId: "s", state: "needs_you" },
              }),
            ],
          },
        }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const lane = page.getByRole("listitem").filter({ hasText: "Refactor del host" });
    await expect(lane.getByText("Objetivo", { exact: true })).toBeVisible();
    await expect(lane.getByRole("link", { name: "Consumo" })).toHaveAttribute(
      "href",
      /\/consumo\?ticket=goal%3A999/,
    );
    await page.screenshot({ path: `${EVIDENCE}/inicio-goal-1280.png` });
  });
});
