import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import type {
  SharedMesa,
  WorkspaceCommand,
  WorkspaceIntent,
  WorkspaceSnapshot,
} from "../shared/workspace.ts";
import type { Workspace } from "../web/features/terminals/mesas.ts";

// The selected Mesa's persisted state replaces the former ids/max/node URL snapshot.
export const currentMesa = (page: Page) =>
  page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("aos.mesas") ?? "null") as Workspace | null;
    const id = new URL(location.href).searchParams.get("mesa") ?? state?.activeId;
    return state?.mesas.find((m) => m.id === id) ?? null;
  });

// The server under test. AOS_E2E_URL points the suite at an isolated instance (its own port
// and data dir), so a run never touches the server and terminals in daily use.
export const origin = process.env.AOS_E2E_URL ?? "http://localhost:4317";
const headers = { origin, "content-type": "application/json" };

// The server's workspace and its commands. The only place in the suite that knows their shape,
// so a change to the contract (shared/workspace.ts) touches these and no test.
export const getWorkspace = async (request: APIRequestContext) =>
  (await (await request.get("/api/workspace")).json()) as WorkspaceSnapshot;

const command = (request: APIRequestContext, body: Omit<WorkspaceCommand, "requestId">) =>
  request.post("/api/workspace/commands", {
    headers,
    data: { requestId: crypto.randomUUID(), ...body } satisfies WorkspaceCommand,
  });

// One change, applied by the server to its current Mesas, as the browser sends it.
export async function workspaceIntent(request: APIRequestContext, intent: WorkspaceIntent) {
  const res = await command(request, { action: { kind: "intent", intent } });
  expect(res.ok(), `${JSON.stringify(intent)}: ${res.status()} ${await res.text()}`).toBe(true);
}

// A new Mesa; the first one on a server that has none is an import.
export async function addMesa(request: APIRequestContext, mesa: SharedMesa) {
  const { revision } = await getWorkspace(request);
  if (revision === 0) {
    const res = await command(request, {
      expectedRevision: 0,
      action: { kind: "import", mesas: [mesa], blocks: [] },
    });
    expect(res.ok(), `create Mesa ${mesa.name}: ${res.status()}`).toBe(true);
    return;
  }
  await workspaceIntent(request, { kind: "create", mesa: mesa.id, name: mesa.name });
  for (const tile of mesa.ids) await workspaceIntent(request, { kind: "add", mesa: mesa.id, tile });
}

// The server's workspace back to one empty «Mesa 1», whatever an earlier test or run left: its
// Mesas, their members and their order.
export async function resetWorkspace(request: APIRequestContext) {
  const mesa = { id: "mesa-1", name: "Mesa 1", ids: [] };
  if ((await getWorkspace(request)).revision === 0) return addMesa(request, mesa);
  await workspaceIntent(request, { kind: "create", mesa: mesa.id, name: mesa.name });
  await workspaceIntent(request, { kind: "rename", mesa: mesa.id, name: mesa.name });
  const { mesas, blocks } = await getWorkspace(request);
  for (const b of blocks ?? [])
    await workspaceIntent(request, { kind: "block-remove", block: b.id });
  for (const m of mesas) {
    if (m.id !== mesa.id) await workspaceIntent(request, { kind: "close", mesa: m.id });
    else
      for (const tile of m.ids)
        await workspaceIntent(request, { kind: "remove", mesa: m.id, tile });
  }
}

// A login shell reads its environment once per PTY host, in up to 45 s (LOGIN_ENV_TIMEOUT_MS,
// server/features/terminals/env.ts:67); past that it fails. 60 s leaves room for the first prompt.
export const READY_MS = 60_000;

// A terminal ready for keys: the server's screen has text, then `view` (a tile, or the page of
// /terminal/:id) draws it. A failure names the half that did not happen: the shell wrote
// nothing (slow or stuck), or it did and the browser shows none of it (a render or restore bug).
export async function waitReady(view: Locator, id?: string) {
  const terminal = id ?? (await view.getAttribute("data-terminal-id"));
  if (!terminal) throw new Error("waitReady: no terminal id on the view; pass it");
  const server = async () => {
    const res = await view.page().request.get(`/api/terminals/${terminal}/text`);
    if (!res.ok()) throw new Error(`GET /api/terminals/${terminal}/text: ${res.status()}`);
    return ((await res.json()) as { text: string }).text;
  };
  await expect
    .poll(server, {
      timeout: READY_MS,
      message: `terminal ${terminal}: the shell wrote nothing in ${READY_MS / 1000} s (slow or stuck shell)`,
    })
    .toMatch(/\S/);
  const rows = view.locator(".xterm-rows");
  await expect
    .poll(async () => (await rows.innerText()).trim().length, {
      timeout: 15_000,
      message: `terminal ${terminal}: the server's screen has text but the browser shows none (render or restore bug)`,
    })
    .toBeGreaterThan(0);
}

// A line typed into a terminal and run, once it is ready for keys.
export async function typeIn(view: Locator, line: string, id?: string) {
  await waitReady(view, id);
  await view.locator(".xterm-helper-textarea").focus();
  await view.page().keyboard.type(line);
  await view.page().keyboard.press("Enter");
}

// Terminals a test launched, stopped and removed: DELETE answers removed false until the
// shell has exited. They leave the Mesas too: a Mesa keeps a removed terminal's tile ("Esta
// terminal ya no existe"), and the next file's layout then starts with it.
export async function removeTerminals(request: APIRequestContext, ids: readonly string[]) {
  for (const id of ids) {
    await request.post(`/api/terminals/${id}/stop`, { headers });
    const removed = async () =>
      (
        (await (await request.delete(`/api/terminals/${id}`, { headers })).json()) as {
          removed?: boolean;
        }
      ).removed;
    await expect
      .poll(removed, { timeout: 8000, message: `terminal ${id}: not removed 8 s after its stop` })
      .toBe(true);
  }
  // A page still open may put one back meanwhile: the poll reads the workspace again.
  const gone = new Set(ids);
  await expect
    .poll(
      async () => {
        const left = (await getWorkspace(request)).mesas.flatMap((m) =>
          m.ids.filter((id) => gone.has(id)).map((tile) => ({ mesa: m.id, tile })),
        );
        for (const at of left) await workspaceIntent(request, { kind: "remove", ...at });
        return left.length === 0;
      },
      { timeout: 8000, message: `terminals ${ids.join(", ")}: still in a Mesa` },
    )
    .toBe(true);
}

// Jira's connection lives in the server's DB, so a server on a data dir of its own (the
// isolated e2e one) has none: only that skips. Any other failure fails, with its body.
export async function skipWithoutJira(request: APIRequestContext) {
  const res = await request.get("/api/tickets");
  const body = await res.text();
  test.skip(
    res.status() === 401 && body.includes('"reconnect_required"'),
    "Jira is not connected on this server (the connection lives in its own DB)",
  );
  expect(res.ok(), `GET /api/tickets: ${res.status()} ${body.slice(0, 200)}`).toBe(true);
}

// No horizontal page scroll, and no control cut off by the viewport, by a clipping
// ancestor (a column with overflow hidden) or by its own text overflowing. Polled: right after
// a resize the Mesa still has the old width's tiles for a frame before it lays them out again.
export async function noClippedControls(page: Page) {
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  await expect.poll(overflow, { message: "no horizontal page scroll" }).toBeLessThanOrEqual(0);
  const clipped = () =>
    page.evaluate(() => {
      const out: string[] = [];
      const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
      for (const el of document.querySelectorAll("button, a.btn, a.btn-ghost, select")) {
        if (!visible(el)) continue;
        const box = el.getBoundingClientRect();
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
        // In a row that scrolls sideways (the phone's terminal keys) a control is reached by
        // scrolling the row, so the row, not the control, has to fit the viewport. A row that grew
        // instead (a <fieldset> keeps its content's width unless given min-width 0) does not.
        // A row, not any scroller: overflow-y auto computes overflow-x auto too, and a vertical
        // panel must not hide a control wider than it.
        const sideways = (p: Element) => {
          const s = getComputedStyle(p);
          return (
            /auto|scroll/.test(s.overflowX) &&
            /flex/.test(s.display) &&
            s.flexDirection === "row" &&
            s.flexWrap === "nowrap"
          );
        };
        let reach = box;
        let where = "viewport";
        for (let p = el.parentElement; p; p = p.parentElement)
          if (sideways(p)) {
            reach = p.getBoundingClientRect();
            where = "viewport, its scrolling row";
            break;
          }
        if (reach.right > document.documentElement.clientWidth + 0.5)
          out.push(
            `${name}: ${where} (${Math.round(reach.right)} > ${document.documentElement.clientWidth})`,
          );
        if (el.scrollWidth > el.clientWidth + 1) out.push(`${name}: text overflow`);
        for (let p = el.parentElement; p; p = p.parentElement) {
          const overflowX = getComputedStyle(p).overflowX;
          if (overflowX === "visible") continue;
          // A row that scrolls sideways (the phone's terminal keys) reaches every control in it;
          // a vertical scroll panel does not, so it is checked like any other clipping column.
          if (sideways(p)) break;
          const clip = p.getBoundingClientRect();
          if (box.left < clip.left - 0.5 || box.right > clip.right + 0.5)
            out.push(`${name}: ancestor`);
          break;
        }
      }
      return out;
    });
  await expect.poll(clipped, { message: "clipped controls" }).toEqual([]);
}

// A tile header's secondary action: in sight from a 26rem header, in «Más acciones» below it.
export async function tileAction(tile: Locator, name: string) {
  const action = tile.getByRole("button", { name, exact: true });
  if (!(await action.isVisible())) await tile.getByRole("button", { name: "Más acciones" }).click();
  return action;
}

// The Mesa's rail: the Mesas over the projects tree, tickets and PRs, one tab at a time.
export const railOf = (page: Page) => page.getByRole("region", { name: "Mesas y proyectos" });

// A tab under the Mesas in the rail; its section is the region named after it.
export const railTab = (page: Page, name: "Proyectos" | "Tickets" | "PRs") =>
  railOf(page)
    .getByRole("group", { name: "Fuentes del carril" })
    .getByRole("button", { name: new RegExp(`^${name}`) });

// The projects tree in the Mesa's rail, opened if the rail is closed and its tab shown.
export async function openTree(page: Page) {
  await expect(page.getByRole("heading", { name: "Mesa", exact: true })).toBeVisible();
  const rail = railOf(page);
  if (!(await rail.isVisible()))
    await page.getByRole("button", { name: "Mostrar el carril" }).click();
  const projects = railTab(page, "Proyectos");
  if ((await projects.getAttribute("aria-pressed")) !== "true") await projects.click();
  // Until /api/projects answers the tree has no repo headings; it reads git for every repo,
  // which under load takes more than an assertion's 5 s.
  await expect(
    rail.getByRole("status", { name: "Cargando" }),
    "the projects tree loads",
  ).toHaveCount(0, { timeout: 30_000 });
  return rail;
}

// The rail's sources open on this tab in every page of this context (kept per browser).
export const railShows = (page: Page, tab: "projects" | "tickets" | "prs") =>
  page.addInitScript((t) => localStorage.setItem("aos.rail.source", t), tab);

// The open Mesa's menu, from a right click on its card in the rail.
export async function mesaMenu(page: Page) {
  await page.locator('[data-mesa][data-state="active"]').click({ button: "right" });
  return page.getByRole("menu");
}

// A node's row in the Mesa's projects tree, by its location.
export const treeRow = (page: Page, node: string) => railOf(page).locator(`[data-node="${node}"]`);

// The tree's data, as the server gives it.
type Repo = { id: string; location: string; main: { path: string; branch: string | null } | null };
export const projectsOf = async (page: Page) =>
  (await (await page.request.get("/api/projects")).json()) as {
    repos: Repo[];
    app: { location: string; label: string };
  };

// A repo's main row is named as the tree names it (`mainLabel`): the repo, then its branch.
export const mainName = (r: Repo) => `${r.id}/${r.main?.branch ?? "principal"}`;

// A repo's heading unfolded, so its main row and worktrees show (headings start folded).
export async function unfoldRepo(page: Page, id: string) {
  const head = treeRow(page, `repo-group:${id}`);
  await expect(head).toBeVisible();
  const unfold = head.getByRole("button", { name: `Desplegar ${id}`, exact: true });
  if (await unfold.count()) await unfold.click();
}

// The app's own node, in sight: its row and its name in the tree's labels. Once Agentic OS
// is listed as a repo it is that repo's main row; otherwise its own folder.
export async function appNode(page: Page) {
  const p = await projectsOf(page);
  const own = p.repos.find((r) => r.location === p.app.location);
  if (own) await unfoldRepo(page, own.id);
  return {
    location: p.app.location,
    name: own ? mainName(own) : p.app.label,
    row: treeRow(page, p.app.location),
  };
}

// What the bar over the tree can open; it names each by these words.
export type Tool = "Shell" | "Claude" | "Codex" | "Grok" | "Git" | "Código";

// A tool for a row: the row marked by its name, then the bar's button for that tool there.
export async function rowPlus(page: Page, node: string, label: string, tool: Tool) {
  const mark = treeRow(page, node).getByRole("button", { name: `Marcar ${label}`, exact: true });
  await mark.click();
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  return railOf(page)
    .getByRole("group", { name: "Abrir en la fila marcada" })
    .getByRole("button", { name: `${tool} en ${label}`, exact: true });
}

// A row's own commands: the line under it that the pointer on the row shows.
export async function rowActions(page: Page, node: string, label: string) {
  await treeRow(page, node).hover();
  const strip = railOf(page).getByRole("group", { name: `Acciones de ${label}`, exact: true });
  await expect(strip).toBeVisible();
  return strip;
}

// What a row's "⋯" opens under it.
export async function rowMore(page: Page, node: string, label: string) {
  const name = `Más acciones en ${label}`;
  await treeRow(page, node).getByRole("button", { name }).click();
  return railOf(page).getByRole("group", { name });
}

// Moves the active row with the arrows until it is the option whose text starts with `name`,
// once the lists it comes from have loaded.
export async function pick(page: Page, dialog: Locator, name: string) {
  const options = dialog.getByRole("option");
  const index = async () =>
    (
      await options.evaluateAll((els) =>
        els.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()),
      )
    ).findIndex((n) => n.startsWith(name));
  await expect.poll(index, { message: name }).toBeGreaterThanOrEqual(0);
  const at = await index();
  for (let i = 0; i < at; i++) await page.keyboard.press("ArrowDown");
  await expect(options.nth(at)).toHaveAttribute("aria-selected", "true");
}
