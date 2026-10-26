import { expect, type Locator, type Page, test } from "@playwright/test";
import type { WorkspaceSnapshot } from "../shared/workspace.ts";
import { pr as prRow } from "../web/features/home/test-fixtures.ts";
import {
  currentMesa,
  mainName,
  noClippedControls,
  openTree,
  origin,
  pick,
  projectsOf,
  railShows,
  railTab,
  removeTerminals,
  resetWorkspace,
  waitReady,
} from "./helpers.ts";

// The Mesa: a ticket brought into a shell tile, by ⌘K "Llevar a…" and by dragging it, and a
// project opened beside the tiles. The isolated server has no Jira, so the ticket list is
// stubbed in the browser; the bring itself is the real route, and a shell only needs the key.
// Only shells at repo:contract are launched, stopped and removed again.
const EVIDENCE = "data/evidence/mesa";
const headers = { origin, "content-type": "application/json" };

const ticket = (key: string, summary: string, status: string, assignee: string | null = "me") => ({
  key,
  summary,
  status: { name: status, category: "indeterminate" },
  issuetype: "Task",
  assignee: assignee
    ? { accountId: assignee, displayName: assignee === "me" ? "Oriol" : "Ana Ruiz" }
    : null,
  reviewers: [],
  parent: null,
  priority: null,
  labels: [],
  points: null,
  size: null,
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

// A row dragged from the rail with real pointer events, the way a hand moves it.
async function dragOnto(page: Page, from: Locator, to: Locator) {
  // Cards can be below the rail's scroll viewport; reveal one before moving the pointer.
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  if (!a) throw new Error("no row");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
  const b = await to.boundingBox();
  if (!b) throw new Error("no tile");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

// The Tickets tab under the Mesas in the rail (the tests open on it).
const ticketsIn = (page: Page) =>
  page
    .getByRole("region", { name: "Mesas y proyectos" })
    .getByRole("region", { name: "Tickets", exact: true });

// A ticket's or PR's thin row, the thing a hand drags onto a tile.
const sourceRow = (within: Locator, key: string) =>
  within.locator("li[draggable]").filter({ hasText: key });

test.describe("mesa", () => {
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

  test.beforeEach(async ({ page, request }) => {
    await resetWorkspace(request);
    await railShows(page, "tickets");
    await page.route(
      (url) => ["/api/tickets", "/api/tickets/team"].includes(url.pathname),
      (route) => {
        const team = new URL(route.request().url()).pathname.endsWith("/team");
        return route.fulfill({
          json: {
            jql: "test query",
            ...(team ? { me: "me" } : {}),
            tickets: [
              ticket("ABC-101", "Arreglar el login", "In Progress"),
              ticket("ABC-102", "Exportar el informe", "To Do"),
              ...(team
                ? [
                    ticket("ABC-103", "Cambios para revisar", "Pull Request", "ana"),
                    ticket("ABC-104", "Validar el producto", "In Product Review", "ana"),
                    ticket("ABC-105", "Implementación en curso", "En curso", "ana"),
                    ticket("ABC-106", "Pendiente del equipo", "To Do", "ana"),
                    ticket("ABC-107", "Preparado para publicar", "Release Ready", "ana"),
                    ticket("ABC-108", "Sin responsable", "Pull Request", null),
                  ]
                : []),
            ],
          },
        });
      },
    );
  });

  test("content by default, the task when asked, through a real drag without Enter", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The isolated server keeps workspace membership between runs. This rail test owns
    // one mesa; other suites' saved tabs must not determine its mobile layout.
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        json: {
          revision: 1,
          mesas: [{ id: "ticket-review", name: "Revisión", ids }],
          blocks: [],
        } satisfies WorkspaceSnapshot,
      }),
    );
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tile = page.locator("section[aria-label^='Shell en ']").first();
    await waitReady(tile);
    const tickets = ticketsIn(page);
    for (const key of ["ABC-101", "ABC-102", "ABC-103", "ABC-104", "ABC-105"])
      await expect(tickets.getByRole("link").filter({ hasText: key })).toHaveCount(1);
    for (const key of ["ABC-106", "ABC-107", "ABC-108"])
      await expect(tickets.getByRole("link").filter({ hasText: key })).toHaveCount(0);
    // A teammate's ticket in progress or review says so.
    await expect(tickets.getByText("Revisar", { exact: true })).toHaveCount(3);
    // The rail scrolls inside itself; the page never scrolls.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
      ),
    ).toBe(0);

    const payloads: unknown[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/bring")) payloads.push(r.postDataJSON());
    });
    const rows = tile.locator(".xterm-rows");
    await dragOnto(page, sourceRow(tickets, "ABC-103"), tile);
    await expect(rows).toContainText("ABC-103");
    await dragOnto(page, sourceRow(tickets, "ABC-104"), tile);
    await expect(rows).toContainText(/ABC-103( https:\/\/\S+\/browse\/ABC-103)?ABC-104/);
    // Content alone by default: no task for a teammate's ticket either.
    expect(payloads).toEqual([{ ticket: "ABC-103" }, { ticket: "ABC-104" }]);
    const withTask = tickets.getByRole("button", { name: "Con tarea" });
    await withTask.click();
    await expect(withTask).toHaveAttribute("aria-pressed", "true");
    await dragOnto(page, sourceRow(tickets, "ABC-102"), tile);
    await expect(rows).toContainText(/ABC-104( https:\/\/\S+\/browse\/ABC-104)?ABC-102/);
    await dragOnto(page, sourceRow(tickets, "ABC-105"), tile);
    await expect(rows).toContainText(/ABC-102( https:\/\/\S+\/browse\/ABC-102)?ABC-105/);
    // With the task: Trabajar for mine, Revisar for a teammate's.
    expect(payloads.slice(2)).toEqual([
      { ticket: "ABC-102", task: "work" },
      { ticket: "ABC-105", task: "review" },
    ]);
    // The choice is kept in this browser; put it back for the next tests.
    await tickets.getByRole("button", { name: "Solo contenido" }).click();
    await page.waitForTimeout(800);
    await expect(rows).not.toContainText("not found");
    await shoot(page, "team-review");
    await tile.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+U");
  });

  test("a team failure preserves personal tickets and can be retried from the tree", async ({
    page,
  }) => {
    let recovered = false;
    await page.route("**/api/tickets/team*", (route) =>
      recovered
        ? route.fallback()
        : route.fulfill({
            status: 502,
            json: { error: "provider_error", provider: "jira", detail: "Jira 503" },
          }),
    );
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tickets = ticketsIn(page);
    await expect(tickets.getByRole("alert")).toContainText("Sin tickets del equipo");
    await expect(tickets.getByRole("link").filter({ hasText: "ABC-102" })).toBeVisible();
    recovered = true;
    const refresh = page.waitForRequest(
      (r) =>
        new URL(r.url()).pathname === "/api/tickets/team" &&
        new URL(r.url()).searchParams.get("fresh") === "1",
    );
    await tickets.getByRole("button", { name: "Reintentar" }).click();
    await refresh;
    await expect(tickets.getByRole("link").filter({ hasText: "ABC-103" })).toBeVisible();
    await expect(tickets.getByRole("alert")).toHaveCount(0);
  });

  test("ticket and PR rows stay thin at every rail width, with their actions on hover", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const summary =
      "Corregir los permisos al exportar informes con filtros avanzados y muchos resultados";
    await page.route("**/api/tickets/team*", (route) =>
      route.fulfill({
        json: {
          me: "me",
          jql: "test",
          tickets: [ticket("ABC-103", summary, "Pull Request", "ana")],
        },
      }),
    );
    // A PR of a repo the tree shows, so it is listed in the PRs tab.
    const pr = { ...prRow(73, "review"), repo: "contract", title: summary, draft: true };
    await page.route("**/api/github/prs*", (route) =>
      route.fulfill({
        json: {
          prs: [pr, { ...prRow(74, "mine"), repo: "contract" }],
          repos: ["contract"],
          errors: [],
        },
      }),
    );
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        json: {
          revision: 1,
          mesas: [{ id: "rail-cards", name: "Revisión", ids }],
          blocks: [],
        } satisfies WorkspaceSnapshot,
      }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const rail = page.getByRole("region", { name: "Mesas y proyectos" });
    const tickets = ticketsIn(page);
    const prs = rail.getByRole("region", { name: "PRs", exact: true });
    for (const width of [1024, 1280, 1536]) {
      await page.setViewportSize({ width, height: 900 });
      await railTab(page, "Tickets").click();
      await expect(tickets.getByRole("link", { name: new RegExp(summary) })).toBeVisible();
      await railTab(page, "PRs").click();
      await expect(prs.getByRole("link", { name: new RegExp(summary) })).toBeVisible();
      // Nothing reaches past the rail's border but its width handle, which straddles it.
      expect(
        await rail.evaluate((el) => {
          const right = el.getBoundingClientRect().right + 0.5;
          return [...el.querySelectorAll("*")].every(
            (x) =>
              x.closest('[role="separator"]') !== null || x.getBoundingClientRect().right <= right,
          );
        }),
      ).toBe(true);
      await noClippedControls(page);
      await page.screenshot({ path: `${EVIDENCE}/rows-${width}.png` });
    }
    await railTab(page, "Tickets").click();
    const row = sourceRow(tickets, "ABC-103");
    await expect(row.getByRole("link")).toHaveAttribute("href", /w=all/);
    // «Copiar contexto» reads the real route: with no Jira on this server it says so.
    await row.hover();
    await row.getByRole("button", { name: "Copiar contexto de ABC-103" }).click();
    const context = page.getByRole("dialog", { name: "Contexto de ABC-103", exact: true });
    await expect(context.getByRole("alert")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(context).toHaveCount(0);

    await railTab(page, "PRs").click();
    const prRowEl = sourceRow(prs, "contract#73");
    await prRowEl.scrollIntoViewIfNeeded();
    await expect(prRowEl.getByText("Borrador")).toBeVisible();
    // The review pill sits in the link; the «Revisar» action beside it says the same word.
    await expect(prRowEl.getByRole("link").getByText("Revisar", { exact: true })).toBeVisible();
    await expect(prRowEl.getByRole("link")).toHaveAttribute("target", "_blank");
    const revise = prRowEl.getByRole("button", { name: "Revisar contract#73", exact: true });
    await revise.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Codex", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(revise).toBeFocused();
    // Exercise the UI boundary without making a GitHub request or launching an agent.
    const brought: unknown[] = [];
    await page.route("**/api/terminals/*/bring", (route) => {
      brought.push(route.request().postDataJSON());
      return route.fulfill({ json: { sent: true, bytes: 20 } });
    });
    const tile = page.locator("section[aria-label^='Shell en ']").first();
    await dragOnto(page, prRowEl, tile);
    await expect.poll(() => brought).toEqual([{ pr: { repo: "contract", number: 73 } }]);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(rail).toBeHidden();
    await noClippedControls(page);
    await page.screenshot({ path: `${EVIDENCE}/rows-mobile-390.png` });
  });

  test("⌘K and a drag type the key into the shell, without Enter", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(0).locator(".tile-num")).toHaveText("1");
    await waitReady(tiles.nth(0));
    const tickets = ticketsIn(page);
    await expect(tickets.getByRole("link").filter({ hasText: "ABC-101" })).toBeVisible();

    // From the search: the ticket, then the tile; the ended tile says why it cannot.
    await page.keyboard.press("Meta+K");
    await page.keyboard.type("abc-101");
    await pick(page, page.getByRole("dialog", { name: "Buscar", exact: true }), "Tickets: ABC-101");
    await page.keyboard.press("Enter");
    const to = page.getByRole("dialog", { name: "Llevar ABC-101 a una terminal", exact: true });
    await expect(to.getByRole("option").nth(1)).toHaveAttribute("aria-disabled", "true");
    await expect(to.getByRole("option").nth(1)).toContainText("la terminal no está en marcha");
    await shoot(page, "llevar");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("status")).toContainText("ABC-101 → 1 · Shell en");
    const rows = tiles.nth(0).locator(".xterm-rows");
    await expect(rows).toContainText("ABC-101");
    // Not run: the shell would say it has no such command.
    await page.waitForTimeout(800);
    await expect(rows).not.toContainText("not found");

    // Dragged onto the tile: the second key lands after the first (each followed by its link
    // when Jira is on), still not run.
    await dragOnto(page, sourceRow(tickets, "ABC-102"), tiles.nth(0));
    await expect(page.getByRole("status")).toContainText("ABC-102 → 1 · Shell en");
    await expect(rows).toContainText(/ABC-101( https:\/\/\S+\/browse\/ABC-101)?ABC-102/);
    await page.waitForTimeout(800);
    await expect(rows).not.toContainText("not found");
    await shoot(page, "dropped");

    // Clear the line so the shell is left as it was.
    await tiles.nth(0).locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+U");
  });

  test("a drag onto an ended tile is refused and types nothing", async ({ page, request }) => {
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(2);
    const tickets = ticketsIn(page);
    let brought = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/bring")) brought++;
    });
    await dragOnto(page, sourceRow(tickets, "ABC-102"), tiles.nth(1));
    await page.waitForTimeout(500);
    expect(brought).toBe(0);
    // The tile refused the drop itself: nothing reached the page to refuse it again.
    await expect(page.getByRole("status")).toHaveText("");
    const res = await request.post(`/api/terminals/${ids[1]}/bring`, {
      headers,
      data: { ticket: "ABC-102" },
    });
    expect(res.status()).toBe(409);
  });

  test("a node link marks the node in the rail, covers no tile, and its chevron folds it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}&node=${encodeURIComponent("repo:contract")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(2);
    const rail = page.getByRole("region", { name: "Mesas y proyectos" });
    await expect(page.getByRole("complementary", { name: /^Proyecto / })).toHaveCount(0);
    const node = rail.locator('[data-node="repo:contract"]');
    await expect(node).toHaveAttribute("aria-current", "true");
    const contract = (await projectsOf(page)).repos.find((r) => r.id === "contract");
    if (!contract) throw new Error("no contract repo");
    const main = mainName(contract);
    // Rail, then the tiles, side by side.
    const [r, a, b] = [
      await rail.boundingBox(),
      await tiles.nth(0).boundingBox(),
      await tiles.nth(1).boundingBox(),
    ];
    if (!r || !a || !b) throw new Error("a box is missing");
    expect(Math.round(a.x)).toBeGreaterThanOrEqual(Math.round(r.x + r.width));
    expect(Math.round(a.y)).toBe(Math.round(b.y));
    expect(Math.round(b.x + b.width)).toBeLessThanOrEqual(1280);

    // The row a link points at is marked, so the bar over the tree opens there; the repo's
    // heading cannot be marked, and its "⋯" opens under it.
    await expect(node.getByRole("button", { name: `Marcar ${main}`, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      rail
        .getByRole("group", { name: "Abrir en la fila marcada" })
        .getByRole("button", { name: `Claude en ${main}`, exact: true }),
    ).toBeEnabled();
    const head = rail.locator('[data-node="repo-group:contract"]');
    // The heading marks its main checkout, the row already marked.
    await expect(
      head.getByRole("button", { name: `Marcar ${main} desde contract` }),
    ).toHaveAttribute("aria-pressed", "true");
    await head.getByRole("button", { name: "Más acciones en contract" }).click();
    await expect(rail.getByRole("group", { name: "Más acciones en contract" })).toContainText(
      "Nuevo worktree",
    );
    await shoot(page, "node-marked");

    // The heading's chevron folds it even while a link points at a row inside; the mark stays.
    // Its name marks the main checkout instead.
    await head.getByRole("button", { name: "Plegar contract", exact: true }).click();
    await expect(node).toHaveCount(0);
    await expect.poll(async () => (await currentMesa(page))?.node).toBe("repo:contract");
    await expect(tiles).toHaveCount(2);
  });

  // Read only: the real profile's envs are left alone; «Ver salida» runs nothing.
  test("an env's actions show under its row on hover, and «Ver salida» opens its output as a tile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/terminales");
    const rail = await openTree(page);
    const envs = rail.getByRole("region", { name: "Entornos" });
    await expect(envs.locator("ul, p, [role=alert]").first()).toBeVisible({ timeout: 20_000 });
    const marks = envs.locator('[data-node^="env:"]').getByRole("button", { name: /^Marcar / });
    test.skip((await marks.count()) === 0, "the profile has no env");
    const label = (await marks.first().getAttribute("aria-label"))?.replace("Marcar ", "");
    if (!label) throw new Error("no env name");
    const row = envs.locator(`[data-node="env:${label}"]`);
    const strip = rail.getByRole("group", { name: `Acciones de ${label}` });
    // Out of sight until the pointer is on the row; then every action, inside the rail.
    await page.mouse.move(0, 0);
    await expect(strip).toBeHidden();
    await row.hover();
    for (const name of [`Actualizar ${label}`, `Logs ${label}`, "Ver salida", "Borrar entorno…"])
      await expect(strip.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^(Levantar|Parar) / }).first()).toBeVisible();
    const [box, end] = [await rail.boundingBox(), await strip.boundingBox()];
    if (!box || !end) throw new Error("no env strip");
    expect(Math.round(end.x + end.width)).toBeLessThanOrEqual(Math.round(box.x + box.width));
    await noClippedControls(page);
    await shoot(page, "env-actions");

    await strip.getByRole("button", { name: "Ver salida" }).click();
    await expect
      .poll(async () => (await currentMesa(page))?.ids)
      .toContain(`job:${encodeURIComponent(label)}`);
    const tile = page.getByRole("region", { name: `Salida de ${label}` });
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(/Resultado:|No hay ninguna acción de/);
    await expect(tile.locator("[data-harness=env]")).toContainText("Entorno");
    await shoot(page, "env-output");
    await tile.getByRole("button", { name: `Quitar Salida de ${label} de la cuadrícula` }).click();
    await expect(tile).toHaveCount(0);
  });
});
