import { expect, type Page, test } from "@playwright/test";
import { ticket } from "../web/features/home/test-fixtures.ts";
import { noClippedControls } from "./helpers.ts";

// The clip gate: the daily pages at desktop widths and on the phone (412). Text cut short with
// no title that holds it hides what the user came to read, and a control past the edge cannot
// be pressed. The real data changes from day to day, so every page also gets one ticket and
// one note with a long key, title and status, appended to what the server answers, or
// answered alone where the server has none (the isolated server has no Jira connection): the
// gate never passes for lack of long text.

const KEY = "CLIP-90210";
const LONG =
  "Revisar la exportación de inventario de racks cuando el centro de datos tiene salas con nombres largos y muchas filas";
const longTicket = {
  ...ticket(KEY, "indeterminate", new Date().toISOString()),
  summary: LONG,
  status: {
    id: "90210",
    name: "Pendiente de revisión por el equipo de plataforma",
    category: "indeterminate",
  },
};
const longNote = {
  id: `notes:${KEY}.md`,
  source: "notes",
  rel: `${KEY}.md`,
  title: `${KEY} · ${LONG}`,
  description: null,
  mtime: Date.now(),
  writable: true,
};

// A tickets list holding only the long ticket, shaped as the server answers it.
const alone = (path: string) => {
  const list = { jql: "clip", tickets: [longTicket], me: null };
  if (!path.endsWith("/board")) return list;
  const column = { name: "Revisión de plataforma", statuses: [longTicket.status.id] };
  const board = { id: "clip", name: "Tablero con un nombre bastante largo", columns: [column] };
  return { ...list, board, boards: [{ id: board.id, name: board.name }] };
};

async function withLongText(page: Page) {
  // Lists only: a ticket's own page (/api/tickets/KEY) is left alone.
  await page.route(/\/api\/tickets(\/board|\/team)?(\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = res.ok() ? await res.json() : alone(new URL(route.request().url()).pathname);
    if (Array.isArray(body.tickets) && res.ok()) body.tickets.push(longTicket);
    await route.fulfill({ status: 200, json: body });
  });
  await page.route(/\/api\/memory\/docs\?source=notes$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (Array.isArray(body.docs)) body.docs.push(longNote);
    await route.fulfill({ response: res, json: body });
  });
  // The long note itself, opened: a long line and a path that cannot break.
  await page.route(/\/api\/memory\/doc\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get("id") !== longNote.id)
      return route.fallback();
    const body = `# ${longNote.title}\n\n- 09:00 ${LONG}\n- /Users/someone/Desktop/Company/REPOSITORIES/PYTHON/sample-backend/apps/assets/services/export.py\n`;
    await route.fulfill({ json: { doc: { ...longNote, body } } });
  });
}

// Every piece of text cut by an ellipsis or a line clamp whose title (its own, an ancestor's
// or a child's) does not hold every word of it. The cut is the truncating element's, so its
// text may sit in children: all of it counts.
const untitledCuts = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (el.closest('[aria-hidden="true"], .xterm, .sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
      if (!text) continue;
      const cut =
        (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) ||
        (cs.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1);
      if (!cut) continue;
      const title = [el.closest("[title]"), el.querySelector("[title]")]
        .map((t) => t?.getAttribute("title") ?? "")
        .join(" ");
      if (text.split(" ").every((word) => title.includes(word))) continue;
      out.push(`${text.slice(0, 60)} (${el.clientWidth}/${el.scrollWidth} px)`);
    }
    return out;
  });

const PAGES: { path: string; name: string; ready?: string[] }[] = [
  { path: "/", name: "Inicio" },
  { path: "/tickets", name: "Tickets" },
  { path: "/agentes", name: "Agentes" },
  // Its figures and Poneglyph's health come after the skeleton: measured once both show.
  {
    path: "/consumo",
    name: "Consumo",
    ready: ["Gasto en este periodo"],
  },
  { path: "/docs", name: "Notas" },
  { path: `/docs?id=${encodeURIComponent(longNote.id)}`, name: "Una nota abierta" },
];

for (const width of [412, 800, 1024, 1280])
  for (const p of PAGES)
    test(`${p.name} at ${width}: no untitled cut, no control past the edge`, async ({ page }) => {
      await withLongText(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(p.path);
      await expect(page.locator("h1:visible").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("status", { name: "Cargando" })).toHaveCount(0, {
        timeout: 30_000,
      });
      for (const region of p.ready ?? [])
        await expect(page.getByRole("region", { name: region })).toBeVisible({ timeout: 30_000 });
      expect.soft(await untitledCuts(page), "text cut with no title").toEqual([]);
      await noClippedControls(page);
    });

// On the phone Notas shows the list or the note, never both: nothing opens by itself, a picked
// note comes with the way back, and going back stays on the list.
test("Notas at 412: the list, then a note, then back to the list", async ({ page }) => {
  await withLongText(page);
  await page.setViewportSize({ width: 412, height: 900 });
  await page.goto("/docs");
  const list = page.getByRole("region", { name: "Lista de notas" });
  const note = page.getByRole("article", { name: "Nota" });
  await expect(list.getByText(longNote.title, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(note).toBeHidden();
  await list.getByText(longNote.title, { exact: true }).first().click();
  await expect(note.getByRole("heading", { name: longNote.title })).toBeVisible();
  await expect(list).toBeHidden();
  await note.getByRole("button", { name: "← Notas" }).click();
  await expect(list).toBeVisible();
  await expect(page).not.toHaveURL(/id=/);
  await expect(note).toBeHidden();
});
