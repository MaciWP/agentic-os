import { expect, type Route, test } from "@playwright/test";
import { noClippedControls, origin } from "./helpers.ts";

// Real server, real Jira. Screenshots hold company data, so they go to data/evidence.
const EVIDENCE = "data/evidence/inicio";

// One synthetic Outlook mail (rule 9: no company data), served in place of the Mac's helper.
const MAIL = {
  id: "9001",
  messageId: `e2e-${Date.now()}@example.test`,
  subject: `e2e mail ${Date.now()}`,
  from: "Ana Ejemplo <ana@example.test>",
  at: new Date().toISOString(),
  unread: true,
  flagged: false,
};

const localDay = (offset: number) => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + 1);
  return { from: start.toISOString(), to: end.toISOString() };
};

test("Inicio has Trabajo, Hoy and Personal, and opens «Ticket a ticket» in the centre", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  for (const name of ["Trabajo", "Hoy", "Personal"])
    await expect(page.getByRole("region", { name, exact: true })).toBeVisible();

  const centre = page.getByRole("region", { name: "Centro" });
  await centre.getByRole("button", { name: "Ticket a ticket" }).click();
  await expect(centre.getByRole("heading", { level: 1, name: "Ticket a ticket" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(centre.getByRole("region", { name: "Hoy" })).toBeVisible();
});

test("the old «Hoy» link lands on Inicio", async ({ page }) => {
  await page.goto("/hoy");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "Resumen del día" })).toBeVisible();
});

test("a typed task reads its day, time and priority; one for today is ticked and taken back", async ({
  page,
}) => {
  await page.goto("/");
  const hoy = page.getByRole("region", { name: "Hoy" });
  const input = hoy.getByRole("textbox", { name: "Nueva tarea" });
  const later = `e2e later ${Date.now()}`;
  await input.fill(`${later} mañana 16:00 !`);
  const chips = hoy.getByRole("list", { name: "Leído en la tarea" });
  await expect(chips.getByRole("button", { name: "Quitar mañana" })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Quitar 16:00" })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Quitar prioridad" })).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("");
  // Due tomorrow: not on today's list.
  await expect(hoy.getByRole("checkbox", { name: later })).toHaveCount(0);

  const title = `e2e task ${Date.now()}`;
  await input.fill(title);
  await input.press("Enter");
  const box = page.getByRole("region", { name: "Tareas" }).getByRole("checkbox", { name: title });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
});

test("a mail dragged to «Hoy» becomes a task linked to it", async ({ page }) => {
  await page.route(/\/api\/mac\/outlook\/inbox(\?|$)/, (route) =>
    route.fulfill({ json: { total: 1, messages: [MAIL] } }),
  );
  await page.goto("/");
  const work = page.getByRole("region", { name: "Trabajo", exact: true });
  const row = work.getByRole("listitem").filter({ hasText: MAIL.subject });
  await row.dragTo(page.getByRole("region", { name: "Hoy" }));
  await expect(
    page.getByRole("region", { name: "Tareas" }).getByRole("checkbox", { name: MAIL.subject }),
  ).toBeVisible();
  await expect(row.getByText("En Hoy")).toBeVisible();
});

test("«Hoy» records the day's meetings once both calendars answered, not once per calendar", async ({
  page,
}) => {
  const after = (ms: number, json: unknown) => async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fulfill({ json });
  };
  await page.route(/\/api\/google\/agenda$/, after(200, { events: [] }));
  await page.route(/\/api\/mac\/outlook\/agenda$/, after(900, { events: [] }));
  await page.route(/\/api\/mac\/outlook\/inbox$/, after(0, { total: 0, messages: [] }));
  const syncs: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/meetings/sync"))
      syncs.push(req.postData() ?? "");
  });
  await page.goto("/");
  await expect.poll(() => syncs.length).toBe(1);
  await page.waitForTimeout(1500);
  expect(syncs).toHaveLength(1);
  expect(JSON.parse(syncs[0] as string).sources).toEqual(["google", "outlook"]);
});

test("Outlook without the Calendars grant offers «Dar permiso», and says when Settings opened", async ({
  page,
}) => {
  // Both answered here: on the real route macOS would ask, or Settings would open, on this Mac.
  await page.route(/\/api\/mac\/outlook\/agenda$/, (route) =>
    route.fulfill({ status: 503, json: { error: "not_granted", detail: "" } }),
  );
  await page.route(/\/api\/mac\/outlook\/inbox$/, (route) =>
    route.fulfill({ json: { total: 0, messages: [] } }),
  );
  let asked = 0;
  await page.route(/\/api\/mac\/outlook\/grant$/, (route) => {
    asked++;
    return route.fulfill({ json: { calendar: "denied", settings: true } });
  });
  await page.goto("/");
  const today = page.getByRole("region", { name: "Hoy" });
  await expect(today.getByText("Outlook: AgenticMac necesita permiso")).toBeVisible();
  await today.getByRole("button", { name: "Dar permiso" }).click();
  await expect(today.getByText("Se ha abierto Ajustes: marca AgenticMac")).toBeVisible();
  expect(asked).toBe(1);
});

test("a meeting of yesterday never closed stays in «Hoy» until it is closed", async ({ page }) => {
  const title = `e2e meeting ${Date.now()}`;
  const day = localDay(-1);
  const start = new Date(Date.parse(day.from) + 10 * 3600_000).toISOString();
  const end = new Date(Date.parse(day.from) + 11 * 3600_000).toISOString();
  const res = await page.request.post("/api/meetings/sync", {
    headers: { origin, "content-type": "application/json" },
    data: {
      ...day,
      sources: ["outlook"],
      events: [
        { source: "outlook", eventKey: title, occurrence: start, title, start, end, allDay: false },
      ],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto("/");
  const open = page.getByRole("region", { name: "Sin cerrar" });
  await expect(open.getByText(title)).toBeVisible();
  await open.getByRole("button", { name: `Cerrar ${title}` }).click();
  await expect(page.getByText(title)).toHaveCount(0);
});

test("a meeting's note is made from «Hoy», its lines become tasks, and it closes", async ({
  page,
}) => {
  const title = `e2e note ${Date.now()}`;
  const line = `e2e line ${Date.now()}`;
  const day = localDay(0);
  const start = new Date(Date.parse(day.from) + 9 * 3600_000).toISOString();
  const end = new Date(Date.parse(day.from) + 10 * 3600_000).toISOString();
  const res = await page.request.post("/api/meetings/sync", {
    headers: { origin, "content-type": "application/json" },
    data: {
      ...day,
      sources: ["outlook"],
      events: [
        { source: "outlook", eventKey: title, occurrence: start, title, start, end, allDay: false },
      ],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto("/");
  const agenda = page.getByRole("region", { name: "Agenda" });
  await agenda.getByRole("button", { name: `Notas de ${title}` }).click();

  const note = page.getByRole("article", { name: `Nota de ${title}` });
  const text = note.getByRole("textbox", { name: "Contenido" });
  await expect(text).toHaveValue(new RegExp(`^# Reunión · ${title} · `));
  await expect(note.getByRole("button", { name: "Nada por pasar a tareas" })).toBeDisabled();
  await text.fill(`${(await text.inputValue()).replace(/- \[ \] $/m, `- [ ] ${line}`)}`);
  await note.getByRole("button", { name: "Guardar" }).click();
  await note.getByRole("button", { name: "Pasar 1 a tareas" }).click();
  await expect(note.getByText("1 tarea pasada a Hoy.")).toBeVisible();
  await expect(note.getByRole("button", { name: "Nada por pasar a tareas" })).toBeVisible();
  await note.getByRole("button", { name: "Cerrar reunión" }).click();
  await expect(note.getByText("Reunión cerrada.")).toBeVisible();

  await note.getByRole("button", { name: "Volver a Hoy" }).click();
  await expect(
    page.getByRole("region", { name: "Tareas" }).getByRole("checkbox", { name: line }),
  ).toBeVisible();
  await expect(agenda.getByRole("button", { name: `Reabrir ${title}` })).toBeVisible();
  // Opened again, the same note: never a second one.
  await agenda.getByRole("button", { name: `Notas de ${title}` }).click();
  await expect(note.getByRole("textbox", { name: "Contenido" })).toHaveValue(new RegExp(line));
});

test("a categorizer's proposal is reviewed in the centre and only what stays ticked is applied", async ({
  page,
}) => {
  const item = (id: string, folder: string | null, reason: string) => ({
    id,
    op: folder ? "move" : "trash",
    folder,
    reason,
    from: "Ejemplo <e@example.test>",
    subject: `e2e ${id}`,
    result: null,
  });
  const proposal = {
    id: 9001,
    account: "personal",
    createdAt: new Date().toISOString(),
    status: "pending",
    items: [item("t1", "Facturas", "Archivas sus facturas"), item("t2", null, "Spam")],
  };
  const applied: unknown[] = [];
  await page.route(/\/api\/mail\/personal\/proposal$/, (route) =>
    route.fulfill({ json: { proposal: applied.length ? null : proposal } }),
  );
  // Mocked: the real route would open a dialog on the Mac.
  await page.route(/\/api\/mail\/proposals\/9001\/apply$/, async (route) => {
    applied.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        proposal: {
          ...proposal,
          status: "applied",
          items: [
            { ...proposal.items[0], result: "ok" },
            { ...proposal.items[1], result: "skipped" },
          ],
        },
      },
    });
  });
  await page.goto("/");
  // The column's footer sits in its aside, under the inbox's own section.
  const personal = page.getByRole("complementary", { name: "Personal" });
  await personal.getByRole("button", { name: "Revisar propuesta · 2" }).click();
  const centre = page.getByRole("region", { name: "Centro" });
  await expect(centre.getByRole("heading", { level: 1, name: "Ordenar Personal" })).toBeVisible();
  await expect(centre.getByText("Archivas sus facturas")).toBeVisible();
  await centre.getByRole("checkbox", { name: /e2e t2/ }).uncheck();
  await expect(centre.getByRole("checkbox", { name: "Todos en Papelera" })).not.toBeChecked();
  await centre.getByRole("button", { name: "Aplicar 1" }).click();
  await expect(centre.getByRole("status")).toHaveText("Aplicada: 1 ordenado · 1 sin marcar.");
  expect(applied).toEqual([{ keep: ["t1"] }]);
  await page.keyboard.press("Escape");
  await expect(centre.getByRole("region", { name: "Hoy" })).toBeVisible();
  await expect(personal.getByRole("button", { name: /Revisar propuesta/ })).toHaveCount(0);
});

for (const width of [1024, 1280, 1600]) {
  test(`Inicio at ${width} clips nothing`, async ({ browser }) => {
    const context = await browser.newContext({
      colorScheme: "dark",
      viewport: { width, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Hoy" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await noClippedControls(page);
    await page.screenshot({ path: `${EVIDENCE}/inicio-${width}-dark.png` });
    await context.close();
  });
}
