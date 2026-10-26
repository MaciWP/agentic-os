import { expect, type Page, test } from "@playwright/test";
import {
  currentMesa,
  noClippedControls,
  origin,
  pick,
  removeTerminals,
  waitReady,
} from "./helpers.ts";

// The ⌘K palette: go to a project from the keyboard, the shortcut left to a focused terminal
// for Ctrl+K, and a ticket brought into a Mesa tile in two steps. The isolated server has no
// Jira, so the ticket list is stubbed in the browser; the bring is the real route.
// Only shells at repo:contract are launched, stopped and removed again.
const EVIDENCE = "data/evidence/palette";
const headers = { origin, "content-type": "application/json" };

const ticket = (key: string, summary: string) => ({
  key,
  summary,
  status: { name: "In Progress", category: "indeterminate" },
  issuetype: "Task",
  assignee: null,
  parent: null,
  priority: null,
  labels: [],
  points: null,
  size: null,
  reviewers: [],
  updated: "2026-10-03T08:00:00Z",
  url: `https://jira.example.test/browse/${key}`,
  descriptionAdf: null,
  descriptionMd: "",
});

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

test.describe("palette", () => {
  const ids: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const res = await request.post("/api/terminals", {
        headers,
        data: { harness: "shell", location: "repo:contract" },
      });
      expect(res.ok()).toBe(true);
      ids.push(((await res.json()) as { terminal: { id: string } }).terminal.id);
    }
    // The second one has ended: a tile that cannot take text.
    await request.post(`/api/terminals/${ids[1]}/stop`, { headers });
    await expect
      .poll(async () => {
        const { terminals } = (await (await request.get("/api/terminals")).json()) as {
          terminals: { id: string; state: string }[];
        };
        return terminals.find((t) => t.id === ids[1])?.state;
      })
      .not.toBe("running");
  });

  test.afterAll(async ({ request }) => {
    await removeTerminals(request, ids);
  });

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/tickets*", (route) =>
      route.fulfill({
        json: {
          jql: "assignee = currentUser()",
          tickets: [ticket("ABC-101", "Categoría de activos")],
        },
      }),
    );
  });

  test("⌘K finds a project from the keyboard and opens it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Ticket a ticket" })).toBeVisible();
    await page.keyboard.press("Meta+K");
    const dialog = page.getByRole("dialog", { name: "Buscar", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeFocused();

    // Accents and case do not matter: "categoria" finds the stubbed ticket.
    await page.keyboard.type("categoria");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByRole("option")).toContainText("ABC-101 Categoría de activos");
    await shoot(page, "search");

    await dialog.getByRole("combobox").fill("contract");
    await pick(page, dialog, "Proyectos: contract");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    // A node opens in the Mesa beside whatever tiles it had.
    await expect.poll(async () => (await currentMesa(page))?.node).toBe("repo:contract");
  });

  test("Ctrl+K stays with a focused terminal; ⌘K still opens the palette", async ({ page }) => {
    await page.goto(`/terminales?ids=${ids[0]}`);
    const tile = page.locator("section[aria-label^='Shell en ']");
    await expect(tile).toHaveCount(1);
    await waitReady(tile);
    const rows = tile.locator(".xterm-rows");
    const textarea = tile.locator(".xterm-helper-textarea");
    await textarea.focus();
    await page.keyboard.type("echo palette-");
    await expect(rows).toContainText("echo palette-");
    // Ctrl+K reaches the shell (zsh cuts to the end of the line, here nothing) and no palette.
    await page.keyboard.press("Control+K");
    await page.waitForTimeout(500);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(rows).toContainText("echo palette-");

    await page.keyboard.press("Meta+K");
    const dialog = page.getByRole("dialog", { name: "Buscar", exact: true });
    await expect(dialog).toBeVisible();
    // The shortcut never reached the shell.
    await expect(rows).not.toContainText("echo palette-k");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(textarea).toBeFocused();
    await page.keyboard.press("Control+U");
  });

  test("a ticket goes into a Mesa tile in two steps, never an ended one", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(2);
    await waitReady(tiles.nth(0));
    let brought = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/bring")) brought++;
    });

    await page.keyboard.press("Meta+K");
    const search = page.getByRole("dialog", { name: "Buscar", exact: true });
    await page.keyboard.type("abc-101");
    await pick(page, search, "Tickets: ABC-101");
    await page.keyboard.press("Enter");

    const to = page.getByRole("dialog", { name: "Llevar ABC-101 a una terminal", exact: true });
    await expect(to).toBeVisible();
    // The two tiles, then «Copiar contexto» and «Abrir el ticket».
    const options = to.getByRole("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(1)).toHaveAttribute("aria-disabled", "true");
    await expect(options.nth(1)).toContainText("la terminal no está en marcha");
    await shoot(page, "bring");

    // Enter on the ended tile does nothing; Esc goes back to the search, not out.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect(brought).toBe(0);
    await expect(to).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toBeVisible();
    await expect(search.getByRole("combobox")).toHaveValue("abc-101");

    await pick(page, search, "Tickets: ABC-101");
    await page.keyboard.press("Enter");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("ABC-101 → 1 · Shell en");
    const rows = tiles.nth(0).locator(".xterm-rows");
    await expect(rows).toContainText("ABC-101");
    // Not run: the shell would say it has no such command.
    await page.waitForTimeout(800);
    await expect(rows).not.toContainText("not found");
    expect(brought).toBe(1);

    await tiles.nth(0).locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+U");
  });

  // Off the Mesa there is no tile to bring it to: its context can be copied, or it opens.
  test("off the Mesa a ticket offers its context to copy, or opens its page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Ticket a ticket" })).toBeVisible();
    await page.keyboard.press("Meta+K");
    const search = page.getByRole("dialog", { name: "Buscar", exact: true });
    await page.keyboard.type("abc-101");
    await pick(page, search, "Tickets: ABC-101");
    await page.keyboard.press("Enter");
    const step = page.getByRole("dialog", { name: "Qué hacer con ABC-101", exact: true });
    await expect(step.getByRole("option")).toHaveCount(2);
    await expect(step.getByRole("option").nth(0)).toContainText("Copiar contexto");
    await expect(step.getByRole("option").nth(1)).toContainText("Abrir el ticket");
    // The isolated server has no Jira: the modal says the provider failed, never an empty text.
    await page.keyboard.press("Enter");
    const context = page.getByRole("dialog", { name: "Contexto de ABC-101", exact: true });
    await expect(context.getByRole("alert")).toBeVisible();
    await expect(context.getByRole("textbox")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press("Meta+K");
    await page.keyboard.type("abc-101");
    await pick(page, search, "Tickets: ABC-101");
    await page.keyboard.press("Enter");
    await pick(page, step, "O bien: Abrir el ticket");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/tickets\/ABC-101$/);
  });

  // The rail shows the PR next to their repos, so the page reads them once; the palette shares
  // that cache and opening it asks for nothing again.
  test("the PR list is read once by the rail, and ⌘K reuses it", async ({ page }) => {
    const prs: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/github/prs") prs.push(r.url());
    });
    await page.goto(`/terminales?ids=${ids[0]}`);
    await expect(page.locator("section[aria-label^='Shell en ']")).toHaveCount(1);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => prs.length).toBe(1);
    await page.keyboard.press("Meta+K");
    await expect(page.getByRole("dialog", { name: "Buscar", exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(prs).toHaveLength(1);
  });
});
