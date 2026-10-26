import { expect, type Page, test } from "@playwright/test";
import { noClippedControls } from "./helpers.ts";

const EVIDENCE = "data/evidence/notas";
const HARNESS = ["claude-memory", "claude-md", "codex", "grok"];

// Every harness document with its mtime, from the server's own index.
async function harnessState(page: Page) {
  const out: string[] = [];
  for (const source of HARNESS) {
    const res = await page.request.get(`/api/memory/docs?source=${source}`);
    expect(res.ok()).toBe(true);
    const { docs } = (await res.json()) as { docs: { id: string; mtime: number }[] };
    for (const d of docs) out.push(`${d.id}@${d.mtime}`);
  }
  return out.sort();
}

const note = (page: Page) => page.getByRole("article", { name: "Nota" });

// Deletes the open note through the UI.
async function deleteOpen(page: Page) {
  const n = note(page);
  if ((await n.getByRole("textbox", { name: "Contenido" }).count()) === 0)
    await n.getByRole("button", { name: "Editar" }).click();
  await n.getByRole("button", { name: "Borrar", exact: true }).click();
  await n.getByRole("button", { name: "Borrar definitivamente" }).click();
}

test("a harness note reads as Markdown, read-only, and survives a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  await expect(page.getByRole("heading", { level: 1, name: "Notas y memoria" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Filtros" })
    .getByRole("button", { name: /^Claude Code · memoria/ })
    .click();
  await page.locator('[data-doc^="claude-memory:"]').first().click();
  await expect(page).toHaveURL(/\/docs\?.*id=claude-memory/);
  const readOnly = note(page).getByText("Solo lectura", { exact: true });
  await expect(readOnly).toBeVisible();
  await expect(note(page).getByRole("textbox", { name: "Contenido" })).toHaveCount(0);
  await expect(note(page).getByRole("button", { name: /^(Editar|Guardar|Borrar)/ })).toHaveCount(0);

  await page.reload();
  await expect(readOnly).toBeVisible();
  await expect(note(page).getByRole("heading", { level: 1 })).not.toBeEmpty();
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/harness-1440.png` });

  // An id outside the index is a plain "not found", never a file read.
  await page.goto("/docs?id=claude-memory:../../settings.json");
  await expect(page.getByText("Ese documento ya no existe o no se puede abrir.")).toBeVisible();
});

test("search finds harness memory with the match highlighted", async ({ page }) => {
  await page.goto("/docs");
  const box = page.getByRole("searchbox", { name: "Buscar en notas y memoria" });
  await box.fill("memoria");
  const results = page.getByRole("list", { name: "Resultados" });
  await expect(results.getByRole("button").first()).toBeVisible();
  await expect(results.locator("mark").first()).toBeVisible();
  await box.fill("zzqxjv");
  await expect(page.getByText("Nada coincide con «zzqxjv».")).toBeVisible();
});

test("the grouping switch lives in the URL and survives a reload", async ({ page }) => {
  await page.goto("/docs");
  const group = page.getByRole("group", { name: "Agrupar" });
  await expect(group.getByRole("button", { name: "Por ticket" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await group.getByRole("button", { name: "Por día" }).click();
  await expect(page).toHaveURL(/[?&]v=dia/);
  await page.reload();
  await expect(group.getByRole("button", { name: "Por día" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Day groups are headed by dates, never by ticket keys.
  const sections = page
    .getByRole("region", { name: "Lista de notas" })
    .locator("section[aria-label]");
  await expect(sections.first()).toHaveAttribute("aria-label", /^\d{4}-\d{2}-\d{2}$/);
});

test("a note is created, edited, found, and deleted; harness files stay untouched", async ({
  page,
}) => {
  const name = `e2e nota ${Date.now()}`;
  const marker = `marcador${Date.now()}`;
  const before = await harnessState(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  await page.getByRole("button", { name: "Nueva nota" }).click();
  await page.getByRole("textbox", { name: "Nombre" }).fill(name);
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\?.*id=notes(:|%3A)/);
  // A new note is only its heading, so it opens in the editor.
  const editor = note(page).getByRole("textbox", { name: "Contenido" });
  await expect(editor).toHaveValue(`# ${name}\n\n`);
  const docUrl = page.url();

  try {
    await editor.fill(`# ${name}\n\nTexto con ${marker}.\n`);
    await expect(page.getByText("Cambios sin guardar")).toBeVisible();
    await note(page).getByRole("button", { name: "Guardar" }).click();
    await expect(note(page).getByRole("status")).toHaveText("Guardado.");
    await page.reload();
    // With text it opens to read, as Markdown.
    await expect(note(page).getByText(`Texto con ${marker}.`)).toBeVisible();
    await noClippedControls(page);
    await page.screenshot({ path: `${EVIDENCE}/note-1440.png` });

    await page.getByRole("searchbox", { name: "Buscar en notas y memoria" }).fill(marker);
    const hit = page
      .getByRole("list", { name: "Resultados" })
      .getByRole("button", { name: new RegExp(name) });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(note(page).getByText(`Texto con ${marker}.`)).toBeVisible();
  } finally {
    // Clean up through the UI even when an assertion above failed.
    await page.goto(docUrl);
    await deleteOpen(page);
    await expect(page).not.toHaveURL(docUrl);
  }
  await expect(page.locator('[data-doc^="notes:"]').filter({ hasText: name })).toHaveCount(0);
  expect(await harnessState(page)).toEqual(before);
});

test("unsaved text survives reading view and another note, and a reload asks first", async ({
  page,
}) => {
  const name = `e2e borrador ${Date.now()}`;
  const draft = `# ${name}\n\nSin guardar ${Date.now()}.\n`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  await page.getByRole("button", { name: "Nueva nota" }).click();
  await page.getByRole("textbox", { name: "Nombre" }).fill(name);
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\?.*id=notes(:|%3A)/);
  const docUrl = page.url();
  const editor = note(page).getByRole("textbox", { name: "Contenido" });
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  try {
    await editor.fill(draft);
    await note(page).getByRole("button", { name: "Leer" }).click();
    await expect(note(page).getByText("Cambios sin guardar")).toBeVisible();
    await note(page).getByRole("button", { name: "Editar" }).click();
    await expect(editor).toHaveValue(draft);

    // Another note and back: the text is still there, in the editor.
    const other = page.locator("[data-doc]").filter({ hasNotText: name }).first();
    await other.click();
    await expect(page).not.toHaveURL(docUrl);
    await page.locator("[data-doc]").filter({ hasText: name }).first().click();
    await expect(editor).toHaveValue(draft);

    // A reload with unsaved text asks; dismissed, the page and the text stay.
    await page.reload({ timeout: 3000 }).catch(() => {});
    expect(dialogs).toEqual(["beforeunload"]);
    await expect(editor).toHaveValue(draft);
  } finally {
    // Leaving for the cleanup drops the draft on purpose.
    page.removeAllListeners("dialog");
    page.on("dialog", (d) => void d.accept());
    await page.goto(docUrl).catch(() => {});
    // Loaded first: an empty note opens straight in the editor, so it has no Editar button.
    await expect(note(page).getByRole("textbox", { name: "Contenido" })).toBeVisible();
    await deleteOpen(page);
    await expect(page).not.toHaveURL(docUrl);
  }
});

test("a quick note without a ticket lands in today's journal, line after line", async ({
  page,
}) => {
  const marker = `apunte${Date.now()}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  const capture = page.getByRole("textbox", { name: "Apunte rápido" });
  await capture.fill(`${marker} uno`);
  await expect(page.getByText("Intro para guardarlo en el diario de hoy")).toBeVisible();
  await capture.press("Enter");
  const saved = page.getByRole("status").filter({ hasText: "Guardado en el diario de hoy." });
  await expect(saved).toBeVisible();
  await capture.fill(`${marker} dos`);
  await capture.press("Enter");
  await expect(saved).toBeVisible();
  await expect(capture).toHaveValue("");

  try {
    await saved.getByRole("button", { name: "Abrir" }).click();
    await expect(note(page).getByRole("heading", { level: 1 })).toHaveText(
      /^Diario \d{4}-\d{2}-\d{2}$/,
    );
    const lines = note(page).getByRole("listitem").filter({ hasText: marker });
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText(`${marker} uno`);
    await expect(lines.nth(1)).toContainText(`${marker} dos`);
    await page.screenshot({ path: `${EVIDENCE}/journal-1440.png` });
  } finally {
    await deleteOpen(page);
  }
});
