import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { commit, git } from "./fixture.ts";
import {
  appNode,
  currentMesa,
  mainName,
  noClippedControls,
  openTree,
  origin,
  removeTerminals,
  resetWorkspace,
  rowMore,
  rowPlus,
  waitReady,
} from "./helpers.ts";

// Real server, real env provider, real repos: read only. The one launch is a plain shell in
// the app's own folder, removed again. Evidence holds company data.
const EVIDENCE = "data/evidence/b5";

// The launches land in «Mesa 1»: start each test from it empty, never from an earlier run's tiles.
test.beforeEach(async ({ request }) => resetWorkspace(request));

type Projects = {
  envs: {
    configured: boolean;
    error: string | null;
    items: { name: string; problem: string | null; checkouts: { dir: string }[] }[];
  };
  repos: {
    id: string;
    location: string;
    group: string | null;
    main: { path: string; branch: string | null } | null;
    worktrees: { branch: string | null; location: string | null }[];
  }[];
};

test("the tree shows every env and repo the server lists, and their worktrees", async ({
  page,
}) => {
  const data = (await (await page.request.get("/api/projects")).json()) as Projects;
  await page.setViewportSize({ width: 1280, height: 800 });
  // The tree lives in the Mesa's rail, under the Mesas.
  await page.goto("/terminales");
  const projects = await openTree(page);
  const envs = projects.getByRole("region", { name: "Entornos" });
  if (data.envs.configured && !data.envs.error) {
    // An env with a problem shows, but cannot be marked to launch in.
    for (const e of data.envs.items.filter((e) => !e.problem)) {
      await expect(envs.getByRole("button", { name: `Marcar ${e.name}`, exact: true })).toHaveCount(
        1,
      );
    }
    // An env starts folded: its checkouts show under the chevron, and fold again.
    const first = data.envs.items.find((e) => !e.problem && e.checkouts.length > 0);
    if (first) {
      const checkout = envs.getByRole("button", {
        name: `Marcar ${first.name}/${first.checkouts[0]?.dir}`,
        exact: true,
      });
      await expect(checkout).toHaveCount(0);
      await envs.getByRole("button", { name: `Desplegar ${first.name}`, exact: true }).click();
      await expect(checkout).toBeVisible();
      await envs.getByRole("button", { name: `Plegar ${first.name}`, exact: true }).click();
      await expect(checkout).toHaveCount(0);
    }
  }
  // Each repo under the section its config names, or «Otros proyectos».
  const section = (r: { group: string | null }) =>
    projects.getByRole("region", { name: r.group ?? "Otros proyectos", exact: true });
  const repos = data.repos[0] ? section(data.repos[0]) : projects;
  for (const r of data.repos) {
    const repos = section(r);
    // A repo is a folded heading; a click on it marks its main row and unfolds it.
    const head = repos.locator(`[data-node="repo-group:${r.id}"]`);
    const mark = head.getByRole("button", { name: `Marcar ${mainName(r)} desde ${r.id}` });
    await mark.click();
    await expect(mark).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("group", { name: "Abrir en la fila marcada" }).getByText(mainName(r)),
    ).toBeVisible();
    await expect(
      repos.getByRole("button", { name: `Marcar ${mainName(r)}`, exact: true }),
    ).toHaveCount(1);
    for (const w of r.worktrees.filter((w) => w.location)) {
      await expect(
        repos.getByRole("button", {
          name: `Marcar ${r.id}/${w.branch}`,
          exact: true,
        }),
      ).toHaveCount(1);
    }
  }
  await noClippedControls(page);
  for (const scheme of ["dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await projects.screenshot({ path: `${EVIDENCE}/projects-1280-${scheme}.png` });
    // The column scrolls, so the lower blocks get their own shots.
    await repos.screenshot({ path: `${EVIDENCE}/repos-1280-${scheme}.png` });
    await projects
      .getByRole("region", { name: "Otros proyectos" })
      .screenshot({ path: `${EVIDENCE}/otros-1280-${scheme}.png` });
  }
});

test("a shell opened from a node lands as a tile in the Mesa, counted on it, and goes away when removed", async ({
  page,
  context,
}) => {
  await page.goto("/terminales");
  const home = await openTree(page);
  await expect(home.getByRole("region", { name: "Otros proyectos" })).toBeVisible();
  const app = await appNode(page);
  // The row says how many run in it; no list of them.
  const count = app.row.getByTitle(/ en marcha dentro$/);
  const inApp = async () =>
    (await count.count()) ? Number.parseInt((await count.getAttribute("title")) ?? "", 10) : 0;
  const before = await inApp();
  await (await rowPlus(page, app.location, app.name, "Shell")).click();
  // The launch opens the Mesa with the new terminal as a tile, or alone on a full grid.
  await page.waitForURL(/\/terminales\?/);
  await expect.poll(async () => (await currentMesa(page))?.ids.length ?? 0).toBeGreaterThan(0);
  const mesa = await currentMesa(page);
  const id = mesa?.max ?? mesa?.ids.at(-1) ?? "";
  expect(id).not.toBe("");
  try {
    await openTree(page);
    await expect.poll(inApp, { timeout: 3000 }).toBe(before + 1);

    // Alone in the grid, so the tile is the only one.
    await page.goto(`/terminales?ids=${id}`);
    const tile = page.locator("section.tile");
    await expect(tile).toHaveCount(1);
    const screen = tile.locator(".xterm-rows");
    await waitReady(tile);
    await tile.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo PANE_$((2*3))");
    await page.keyboard.press("Enter");
    await expect(screen).toContainText("PANE_6");

    // "Ventana aparte" takes it; the tile says so and does not take it back alone.
    const popup = page.waitForEvent("popup");
    await tile.getByRole("button", { name: "Ventana aparte" }).click();
    const window = await popup;
    await window.waitForURL(new RegExp(`/terminal/${id}`));
    await expect(window.getByText("en marcha")).toBeVisible();
    await expect(tile.getByText("Abierta en otra ventana.")).toBeVisible();
    // A reload of the same view does not take either: the host answers busy.
    const again = await context.newPage();
    await again.goto(page.url());
    await expect(again.locator("section.tile").getByText("Abierta en otra ventana.")).toBeVisible();
    await again.close();
    await page.waitForTimeout(1500);
    await expect(window.getByText("Abierta en otra ventana.")).toHaveCount(0);

    await tile.getByRole("button", { name: "Traer aquí" }).click();
    await expect(window.getByText("Abierta en otra ventana.")).toBeVisible();
    await tile.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo BACK_$((3*3))");
    await page.keyboard.press("Enter");
    await expect(screen).toContainText("BACK_9");
    await window.close();
  } finally {
    await removeTerminals(page.request, [id]);
  }
  await page.goto("/terminales");
  await openTree(page);
  await expect.poll(inApp, { timeout: 3000 }).toBe(before);
});

test("a take asked for one tile never carries to the next terminal added", async ({
  page,
  context,
}) => {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const shell = async () =>
    (
      (await (
        await api("/api/terminals", "POST", { harness: "shell", location: "app" })
      ).json()) as {
        terminal: { id: string };
      }
    ).terminal.id;
  const a = await shell();
  const b = await shell();
  const elsewhere = "Abierta en otra ventana.";
  try {
    await page.goto(`/terminales?ids=${a}&node=app`);
    const tiles = page.locator("section.tile");
    const tileA = tiles.first();
    await waitReady(tileA);
    // A window takes `a`; the tile takes it back with "Traer aquí".
    const windowA = await context.newPage();
    await windowA.goto(`/terminal/${a}`);
    await expect(tileA.getByText(elsewhere)).toBeVisible();
    await tileA.getByRole("button", { name: "Traer aquí" }).click();
    await expect(windowA.getByText(elsewhere)).toBeVisible();
    // Another window holds `b`; adding it as a tile from «Fuera de las Mesas» must not take it.
    const windowB = await context.newPage();
    await windowB.goto(`/terminal/${b}`);
    await expect(windowB.getByText("en marcha")).toBeVisible();
    await page
      .getByRole("region", { name: "Fuera de las Mesas" })
      .locator(`[data-loose="${b}"]`)
      .click();
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(1).getByText(elsewhere)).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(windowB.getByText(elsewhere)).toHaveCount(0);
    await windowA.close();
    await windowB.close();
  } finally {
    await removeTerminals(page.request, [a, b]);
  }
});

for (const width of [1280, 390]) {
  test(`an old projects link ${width}: the Mesa with the node marked and the terminal as a tile`, async ({
    browser,
  }) => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const api = (path: string, method = "POST", data: unknown = {}) =>
      page.request.fetch(path, {
        method,
        headers: { origin, "content-type": "application/json" },
        data,
      });
    const { terminal } = (await (
      await api("/api/terminals", "POST", { harness: "shell", location: "app" })
    ).json()) as { terminal: { id: string } };
    try {
      await page.goto(`/proyectos?node=app&t=${terminal.id}&tab=git`);
      await expect.poll(async () => (await currentMesa(page))?.ids).toContain(terminal.id);
      await expect.poll(async () => (await currentMesa(page))?.node).toBe("app");
      await expect(page.getByRole("link", { name: "Mesa" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      // The sidebar has no projects page any more.
      await expect(
        page
          .getByRole("navigation", { name: "Principal" })
          .getByRole("link", { name: "Proyectos" }),
      ).toHaveCount(0);
      // No drawer takes the room: the tile shows at once, and on a desktop the rail marks the
      // node (below md there are no rails).
      await expect(page.getByRole("complementary", { name: /^Proyecto / })).toHaveCount(0);
      const tile = page.locator("section.tile");
      await expect(tile).toBeVisible();
      if (width >= 768)
        await expect((await appNode(page)).row).toHaveAttribute("aria-current", "true");
      await waitReady(tile);
      await noClippedControls(page);
      for (const scheme of ["dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: `${EVIDENCE}/mesa-node-${width}-${scheme}.png` });
      }
    } finally {
      await removeTerminals(page.request, [terminal.id]);
      await page.close();
    }
  });
}

// «Añadir repo» in the app's folder picker: a throwaway folder holds a git repo and a plain
// folder. Only the repo can be picked; added, it shows in «Otros proyectos» and leaves again.
test("the folder picker adds a git root as a repo and the tree takes it off again", async ({
  page,
}) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "aos-picker-")));
  try {
    const repo = join(parent, "picked");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "README.md");
    mkdirSync(join(parent, "plain"));

    await page.goto("/terminales");
    const rail = await openTree(page);
    await rail.getByRole("button", { name: "Añadir repo" }).click();
    const dialog = page.getByRole("dialog", { name: "Añadir repo" });
    const field = dialog.getByRole("combobox", { name: "Ruta de la carpeta" });
    const list = dialog.getByRole("listbox", { name: "Carpetas" });
    const action = dialog.getByRole("button", { name: "Añadir este repo" });
    // It opens on a place, typed into at once.
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(/\/$/);

    await field.fill(`${parent}/`);
    await field.press("Enter");
    await expect(field).toHaveValue(`${parent}/`);
    await expect(list.getByRole("option")).toHaveText(["pickedgit", "plain"]);
    // The folder holding them is no repo: the action waits and says why.
    await expect(dialog.getByText("Elige la raíz de un repo de git.")).toBeVisible();
    await expect(action).toBeDisabled();

    // Typing filters; ↓ moves; Enter opens the active folder.
    await field.pressSequentially("p");
    await field.press("ArrowDown");
    await expect(list.getByRole("option", { name: "plain" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await field.press("Enter");
    await expect(field).toHaveValue(`${parent}/plain/`);
    await expect(dialog.getByText("Sin subcarpetas.")).toBeVisible();
    await expect(action).toBeDisabled();
    await dialog.getByRole("button", { name: "Subir a la carpeta de arriba" }).click();
    await expect(field).toHaveValue(`${parent}/`);
    await field.pressSequentially("pi");
    await expect(list.getByRole("option")).toHaveText(["pickedgit"]);
    await field.press("Enter");
    await expect(field).toHaveValue(`${parent}/picked/`);
    await expect(action).toBeEnabled();
    await noClippedControls(page);
    await page.screenshot({ path: `${EVIDENCE}/folder-picker-1280.png` });

    await field.press("ControlOrMeta+Enter");
    await expect(dialog).toHaveCount(0);
    const others = rail.getByRole("region", { name: "Otros proyectos" });
    // It lands marked: its heading opens on its main row, named by the branch.
    await expect(others.locator('[data-node="repo:picked"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(
      others.getByRole("button", { name: "Marcar picked/main", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const strip = await rowMore(page, "repo-group:picked", "picked");
    await strip.getByRole("button", { name: "Quitar de la lista" }).click();
    await expect(rail.locator('[data-node="repo-group:picked"]')).toHaveCount(0);
  } finally {
    // Off the list even when a step failed, so the next run can add it again.
    await page.request.fetch("/api/projects/repos/picked", {
      method: "DELETE",
      headers: { origin, "content-type": "application/json" },
      data: {},
    });
    rmSync(parent, { recursive: true, force: true });
  }
});
