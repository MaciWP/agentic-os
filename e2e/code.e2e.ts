import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  appNode,
  currentMesa,
  noClippedControls,
  projectsOf,
  resetWorkspace,
  rowPlus,
} from "./helpers.ts";

// The code tile on the app's own checkout. The tree against the disk, a file in VS Code's
// editor and colours under the page's CSP, ⌘P, ⌘-click to a definition and back, the views
// (Markdown, image, indented JSON), and the git diff's "Abrir en Código". Evidence holds
// company data. Saves only touch files these tests write under data/e2e (ignored by git).
const EVIDENCE = "data/evidence/code";

declare global {
  interface Window {
    cspViolations: string[];
  }
}

test.beforeEach(async ({ request }) => resetWorkspace(request));

// The line where `export function placeResolver` sits now: other sessions edit this tree.
const definitionLine = () =>
  readFileSync("server/place.ts", "utf8")
    .split("\n")
    .findIndex((l) => l.startsWith("export function placeResolver")) + 1;

// The app's checkout in a wide code tile, CSP violations recorded.
async function openTile(page: Page) {
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.cspViolations.push(`${e.effectiveDirective} ${e.blockedURI || "inline"}`);
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/terminales?node=app");
  const p = await projectsOf(page);
  const { name: appName, location } = await appNode(page);
  const launch = await rowPlus(page, location, appName, "Código");
  await expect(launch).toBeVisible();
  await noClippedControls(page);
  await launch.click();
  await expect
    .poll(async () => (await currentMesa(page))?.ids)
    .toContain(`code:${encodeURIComponent(p.app.location)}`);
  const tile = page.getByRole("region", { name: `Código de ${appName}` });
  await expect(tile).toBeVisible();
  const tree = tile.getByRole("tree", { name: "Ficheros" });
  const row = (path: string) => tree.locator(`[data-path="${path}"]`);
  // The read-only viewer (indented JSON, touch screens) and the editor's visible lines.
  const code = tile.locator("[data-code-text]");
  const editor = tile.locator("[data-code-editor]");
  const lines = editor.locator(".view-lines");
  // ⌘P: open a file by its path.
  const quickOpen = async (path: string) => {
    await tree.locator('[tabindex="0"]').focus();
    await page.keyboard.press("ControlOrMeta+p");
    const search = tile.getByRole("combobox", { name: "Abrir fichero" });
    await search.fill(path);
    await expect(tile.getByRole("option").first()).toContainText(path.split("/").pop() ?? "");
    await search.press("Enter");
    await expect(search).toHaveCount(0);
  };
  return { tile, tree, row, code, editor, lines, quickOpen };
}

test("code opens as a Mesa tile: tree, colours, quick open, definition, back", async ({ page }) => {
  const { tile, tree, row, editor, lines: code } = await openTile(page);

  // The tree: folders first, what git ignores greyed, never .git. One Tab stop for all of it.
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  await expect(row("server")).toHaveAttribute("aria-expanded", "false");
  await expect(row("node_modules")).toHaveAttribute("title", /ignorado por git/);
  await expect(row(".git")).toHaveCount(0);
  await row("server").click();
  await row("server/place.ts").click();

  // The file in colour: the same text as the disk, Dark+ blue on `function`, and the
  // outermost bracket pair in VS Code's gold.
  await expect(code).toContainText("export function placeResolver(");
  const keyword = code.locator("span", { hasText: /^function$/ }).first();
  await expect(keyword).toHaveCSS("color", "rgb(86, 156, 214)");
  await expect(tile.getByText("TypeScript ·", { exact: false })).toBeVisible();
  await expect(code.locator("span", { hasText: /^\($/ }).first()).toHaveCSS(
    "color",
    "rgb(255, 215, 0)",
  );
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  expect(await code.locator("span").count()).toBeGreaterThan(50);
  await page.screenshot({ path: `${EVIDENCE}/code-tile-1440-dark.png` });

  // ⌘P inside the tile finds a file by its path.
  await row("server/place.ts").focus();
  await page.keyboard.press("ControlOrMeta+p");
  const search = tile.getByRole("combobox", { name: "Abrir fichero" });
  await expect(search).toBeFocused();
  await search.fill("server/features/code/routes.ts");
  await expect(tile.getByRole("option").first()).toContainText("routes.ts");
  await search.press("Enter");
  await expect(search).toHaveCount(0);
  // The editor draws only the lines in view: the import of the name is near the top.
  await expect(code).toContainText("import { type Places, placeResolver }");

  // ⌘/Ctrl+click on a name jumps to its one definition and marks the line; ⌃- comes back.
  await code
    .locator("span", { hasText: /^placeResolver$/ })
    .first()
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(code).toContainText("export function placeResolver(");
  await expect(editor.locator(".active-line-number")).toHaveText(String(definitionLine()));
  await expect(row("server/place.ts")).toHaveAttribute("aria-selected", "true");
  // Both are seen, not only announced: a colour utility the theme lacks paints nothing.
  const clear = "rgba(0, 0, 0, 0)";
  await expect(row("server/place.ts")).not.toHaveCSS("background-color", clear);
  await expect(editor.locator(".code-line-mark")).not.toHaveCSS("background-color", clear);
  await page.screenshot({ path: `${EVIDENCE}/code-definition-1440-dark.png` });
  await page.keyboard.press("Control+-");
  await expect(code).toContainText("import { type Places, placeResolver }");
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/code-definition-back-1440-dark.png` });

  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
});

test("a file shows as what it is: Markdown, image, indented JSON", async ({ page }) => {
  // No minified JSON is tracked: one in the ignored data/e2e, removed at the end.
  const minified = "data/e2e/code-minified.json";
  const value = { name: "agentic-os", items: Array.from({ length: 40 }, (_, i) => ({ i })) };
  writeFileSync(minified, JSON.stringify(value));
  try {
    const { tile, row, lines, quickOpen } = await openTile(page);

    // Markdown opens formatted; "Código" shows its source. Its poll asks with the ETag, so an
    // unchanged file costs a 304.
    const revalidated = page.waitForRequest(
      async (r) =>
        r.url().includes("/api/code/file?") && Boolean((await r.allHeaders())["if-none-match"]),
      { timeout: 15_000 },
    );
    await row("README.md").click();
    const view = tile.getByRole("region", { name: "Vista de README.md" });
    // Prose starts at h2: the page has its own h1.
    await expect(view.getByRole("heading", { name: "Agentic OS", level: 2 })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/code-markdown-1440-dark.png` });
    // The wire carries a 304 and no body; Playwright reports the 200 the cache makes of it.
    expect((await (await revalidated).sizes()).responseBodySize).toBe(0);
    await tile.getByRole("button", { name: "Código", exact: true }).click();
    await expect(lines).toContainText("# Agentic OS");

    // An image is itself, with its size in the header.
    await quickOpen("e2e/fixtures/code-image.png");
    const img = tile.locator("main img");
    await expect
      .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBeGreaterThan(0);
    await expect(tile.locator("main header")).toContainText(/\d+ × \d+ px/);
    await page.screenshot({ path: `${EVIDENCE}/code-image-1440-dark.png` });

    // JSON on one line: "Formatear" indents it in the file, as an edit that saves.
    await row("data").click();
    await row("data/e2e").click();
    await row(minified).click();
    await expect(lines).toContainText('{"name":"agentic-os"');
    await tile.getByRole("button", { name: "Formatear" }).click();
    await expect(lines).toContainText('"name": "agentic-os"');
    await expect
      .poll(() => readFileSync(minified, "utf8"))
      .toBe(`${JSON.stringify(value, null, 2)}\n`);
    await expect(tile.locator("main header").getByRole("status")).toHaveText("Guardado");

    // Deleted under the tile: it says so, and once its row leaves the tree another row takes
    // Tab.
    rmSync(minified);
    await expect(tile.getByText("Este fichero ya no existe")).toBeVisible({ timeout: 30_000 });
    await expect(row(minified)).toHaveCount(0, { timeout: 30_000 });
    await expect(tile.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

    // A table of contents scrolls to its heading inside the document, not to a new tab.
    await quickOpen("e2e/fixtures/code-toc.md");
    const doc = tile.getByRole("region", { name: /^Vista de / });
    await doc.getByRole("link", { name: "Use Compound Components" }).click();
    await expect(
      doc.getByRole("heading", { name: "1.2 Use Compound Components" }),
    ).toBeInViewport();
    expect(page.context().pages()).toHaveLength(1);

    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  } finally {
    rmSync(minified, { force: true });
  }
});

test("the git diff opens its file in the code tile, at its first change", async ({ page }) => {
  const status = (await (await page.request.get("/api/git/status?location=app")).json()) as {
    files: { path: string; y: string; kind: string }[];
  };
  // An unstaged edit to a file that is still there.
  const file = status.files.find((f) => f.kind === "changed" && f.y === "M");
  test.skip(!file, "the checkout has no unstaged edit to open");
  if (!file) return;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/terminales?node=app");
  const { name: appName, location } = await appNode(page);
  await (await rowPlus(page, location, appName, "Git")).click();
  const git = page.getByRole("region", { name: `Git de ${appName}` });
  await git.locator(`[data-pick="${`w:${file.path}`}"]`).click();
  const diff = git.getByRole("region", { name: `Diff de ${file.path}` });
  await diff.getByRole("button", { name: "Abrir en Código" }).click();

  const tile = page.getByRole("region", { name: `Código de ${appName}` });
  await expect(tile).toBeVisible();
  await expect(tile.locator("main header")).toContainText(file.path.split("/").pop() ?? "");
  await expect(tile.locator(".code-line-mark")).toBeVisible();
  // Beside the git tile the code tile is narrow: one pane, the file; "Ficheros" turns to the
  // tree, unfolded down to it.
  const tree = tile.getByRole("tree", { name: "Ficheros" });
  await expect(tree).toBeHidden();
  await tile.getByRole("button", { name: "Ficheros", exact: true }).click();
  await expect(tree.locator(`[data-path="${file.path}"]`)).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: `${EVIDENCE}/code-from-git-diff-1440-dark.png` });
});

// VS Code's colours for these lines, as the viewer paints them in Chrome: Shiki on V8 with the
// regex target the page uses there.
async function shikiColours(text: string, lang: string): Promise<string[][]> {
  const { createHighlighterCore } = await import("shiki/core");
  const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
  const { bundledLanguages } = await import("shiki/langs");
  const darkPlus = (await import("shiki/themes/dark-plus.mjs")).default;
  const grammar = lang === "jinja-html" ? "jinja" : lang;
  const h = await createHighlighterCore({
    themes: [darkPlus],
    langs: [bundledLanguages[grammar as keyof typeof bundledLanguages]],
    engine: createJavaScriptRegexEngine({ forgiving: true, target: "auto" }),
  });
  const rgb = (hex = "#d4d4d4") =>
    `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  return h
    .codeToTokensBase(text, { lang, theme: "dark-plus" })
    .map((line) => line.flatMap((t) => [...t.content].map(() => rgb(t.color))));
}

// The editor's visible lines as line number → each character's painted colour.
const paintedLines = (page: Page) =>
  page.evaluate(() => {
    const ed = document.querySelector("[data-code-editor]");
    const top = (el: Element) => Number.parseFloat((el as HTMLElement).style.top);
    const numbers = new Map(
      [...(ed?.querySelectorAll(".line-numbers") ?? [])].map((n) => [
        top(n.closest("[style*='top']") ?? n),
        Number(n.textContent),
      ]),
    );
    return [...(ed?.querySelectorAll(".view-line") ?? [])].flatMap((l) => {
      const line = numbers.get(top(l));
      if (!line) return [];
      const chars = [...l.querySelectorAll(":scope > span > span")].flatMap((s) =>
        [...(s.textContent ?? "").replace(/ /g, " ")].map((c) => ({
          c,
          color: getComputedStyle(s).color,
        })),
      );
      return [{ line, chars }];
    });
  });

test("the editor: under the CSP, smooth on a big file, same colours, keys", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (/web worker|Time limit reached/i.test(m.text())) warnings.push(m.text());
  });
  // Fixtures for the colours: Python, YAML with a non-ASCII comment, a Django template.
  const dir = "data/e2e/code-colours";
  const samples = {
    "sample.py":
      'import os\n\n\ndef greet(name: str) -> str:\n    """Say hi."""\n    return f"hola {name}"  # año\n\n\nclass Box:\n    size = 3\n',
    "sample.yaml":
      "# año y más\nname: agentic\nitems:\n  - one: 1\n    two: 'dos'\n  - three: true\n",
    "template.html":
      '{% extends "base.html" %}\n{% block body %}\n<div class="x">{{ user.name|title }}</div>\n{% endblock %}\n',
  };
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(samples)) writeFileSync(`${dir}/${name}`, body);
  // The keys go to a copy of a 1 000-line TSX file, never to a tracked one.
  writeFileSync(`${dir}/big.tsx`, readFileSync("web/features/memory/desk.tsx"));
  try {
    const { tile, row, editor, lines, quickOpen } = await openTile(page);
    const evidence: Record<string, unknown> = {};

    // The main thread: a 10 ms timer measures the longest it was busy.
    await page.evaluate(() => {
      const gap = { max: 0, last: performance.now() };
      Object.assign(window, { gap });
      setInterval(() => {
        const now = performance.now();
        gap.max = Math.max(gap.max, now - gap.last);
        gap.last = now;
      }, 10);
    });
    const longest = () =>
      page.evaluate(() => {
        const gap = (window as unknown as { gap: { max: number } }).gap;
        const max = Math.round(gap.max);
        gap.max = 0;
        return max;
      });
    await page.evaluate(() =>
      setTimeout(() => {
        const end = performance.now() + 150;
        while (performance.now() < end);
      }),
    );
    await expect.poll(longest).toBeGreaterThanOrEqual(150);

    // A 1 000-line TSX file, its grammar cold: Monaco loads, colours, and the page keeps
    // answering.
    await row("data").click();
    await row("data/e2e").click();
    await row(dir).click();
    await row(`${dir}/big.tsx`).click();
    await expect.poll(() => lines.locator("span[class^='mtk']").count()).toBeGreaterThan(100);
    await page.waitForTimeout(800);
    evidence.openColdMs = await longest();
    // Its last line, which Monaco reads from line 1 to colour.
    await lines.click();
    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await page.waitForTimeout(800);
    evidence.jumpToEndMs = await longest();
    // Monaco starts its worker when a feature asks; a worker that cannot start would run on
    // this thread and warn (caught below).
    evidence.editorWorker = page.workers().some((w) => w.url().includes("editor.worker"));

    // 50 keys at the top of that file: each painted within a frame or two.
    await page.keyboard.press("ControlOrMeta+ArrowUp");
    await page.evaluate(() => {
      const keys: number[] = [];
      Object.assign(window, { keys });
      window.addEventListener(
        "keydown",
        (e) => {
          const start = e.timeStamp;
          requestAnimationFrame(() => setTimeout(() => keys.push(performance.now() - start)));
        },
        true,
      );
    });
    await page.keyboard.type("q".repeat(50), { delay: 40 });
    await expect(lines).toContainText("q".repeat(50));
    const keys = await page.evaluate(() =>
      (window as unknown as { keys: number[] }).keys.map(Math.round),
    );
    evidence.keys = { count: keys.length, max: Math.max(...keys), all: keys };

    // ⌘V pastes text into the editor; ⌘K is still the app's palette.
    await page.evaluate(() => navigator.clipboard.writeText("pegado-desde-el-portapapeles"));
    await page.keyboard.press("ControlOrMeta+v");
    await expect(lines).toContainText("pegado-desde-el-portapapeles");
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Buscar", exact: true });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    // The same colours as the viewer, character by character, brackets aside (both colour
    // them by depth, each its own way).
    const colours: Record<string, number> = {};
    const compare = async (path: string, lang: string, header: string) => {
      await expect(tile.locator("main header")).toContainText(header);
      await expect.poll(() => lines.locator("span[class^='mtk']").count()).toBeGreaterThan(5);
      await page.waitForTimeout(300);
      const want = await shikiColours(readFileSync(path, "utf8"), lang);
      const shown = await paintedLines(page);
      let checked = 0;
      const wrong: string[] = [];
      for (const { line, chars } of shown) {
        chars.forEach(({ c, color }, i) => {
          if (/[\s()[\]{}]/.test(c)) return;
          checked++;
          const expected = want[line - 1]?.[i];
          if (color !== expected) wrong.push(`${line}:${i + 1} ${c} ${color} ≠ ${expected}`);
        });
      }
      colours[path] = checked;
      expect(checked).toBeGreaterThan(20);
      expect(wrong.slice(0, 10)).toEqual([]);
    };
    await quickOpen("server/place.ts");
    await compare("server/place.ts", "typescript", "TypeScript");
    await row(`${dir}/sample.py`).click();
    await compare(`${dir}/sample.py`, "python", "Python");
    await row(`${dir}/sample.yaml`).click();
    await compare(`${dir}/sample.yaml`, "yaml", "YAML");
    await row(`${dir}/template.html`).click();
    await compare(`${dir}/template.html`, "jinja-html", "Jinja HTML");
    evidence.coloursChecked = colours;
    await page.screenshot({ path: `${EVIDENCE}/code-editor-1440-dark.png` });

    evidence.csp = await page.evaluate(() => window.cspViolations);
    evidence.warnings = warnings;
    writeFileSync(`${EVIDENCE}/code-editor-spike.json`, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(evidence.csp).toEqual([]);
    expect(warnings).toEqual([]);
    expect(evidence.openColdMs).toBeLessThan(250);
    expect(evidence.jumpToEndMs).toBeLessThan(250);
    expect(keys.length).toBe(50);
    expect(Math.max(...keys)).toBeLessThan(50);
    await expect(editor).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edits save by themselves; an agent's edit comes in; a conflict asks", async ({
  page,
  browser,
}) => {
  const dir = "data/e2e/code-edit";
  const file = `${dir}/note.ts`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "export const a = 1;\n");
  writeFileSync(`${dir}/other.ts`, "export const b = 1;\n");
  try {
    const { tile, row, lines } = await openTile(page);
    const status = tile.locator("main header").getByRole("status");
    const conflict = tile.getByRole("alert");
    const disk = () => readFileSync(file, "utf8");
    await row("data").click();
    await row("data/e2e").click();
    await row(dir).click();
    await row(file).click();
    await expect(lines).toContainText("export const a = 1;");

    // Typed, and on disk a moment later with no button.
    await lines.click();
    await page.keyboard.press("ControlOrMeta+ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.type(" // mío");
    await expect(status).toHaveText(/Sin guardar|Guardando…|Guardado/);
    await expect.poll(disk).toBe("export const a = 1; // mío\n");
    await expect(status).toHaveText("Guardado");

    // An agent writes the file while nothing is unsaved: its text comes in by itself.
    writeFileSync(file, "export const a = 2; // agente\n");
    await expect(lines).toContainText("// agente", { timeout: 15_000 });
    await expect(conflict).toHaveCount(0);

    // An agent writes it under unsaved keys: the editor stops saving and asks.
    await page.keyboard.press("ControlOrMeta+ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.type(" sin guardar");
    writeFileSync(file, "export const a = 3; // agente otra vez\n");
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(status).toHaveText("Cambiado en disco");
    await page.screenshot({ path: `${EVIDENCE}/code-conflict-1440-dark.png` });
    expect(disk()).toBe("export const a = 3; // agente otra vez\n");
    await conflict.getByRole("button", { name: "Usar la versión del disco" }).click();
    await expect(conflict).toHaveCount(0);
    await expect(lines).toContainText("// agente otra vez");
    await expect(lines).not.toContainText("sin guardar");
    expect(disk()).toBe("export const a = 3; // agente otra vez\n");

    // Again, and this time mine wins.
    await lines.click();
    await page.keyboard.press("ControlOrMeta+ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.type(" mía");
    writeFileSync(file, "export const a = 4;\n");
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await conflict.getByRole("button", { name: "Guardar la mía encima" }).click();
    await expect.poll(disk).toBe("export const a = 3; // agente otra vez mía\n");
    await expect(status).toHaveText("Guardado");
    await expect(conflict).toHaveCount(0);

    // Typed and straight to another file while the save is on its way (held a second here):
    // it lands, and reopening finds no draft.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/code/file", async (route) => {
      if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1_000));
      await route.continue();
    });
    await lines.click();
    await page.keyboard.press("ControlOrMeta+ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.type(" fuera");
    await row(`${dir}/other.ts`).click();
    await expect(lines).toContainText("export const b = 1;");
    await expect.poll(disk).toBe("export const a = 3; // agente otra vez mía fuera\n");
    await page.unrouteAll();
    await row(file).click();
    await expect(lines).toContainText("mía fuera");
    await expect(status).toHaveText("Guardado");
    await page.waitForTimeout(6_000); // past one poll
    await expect(conflict).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);

    // A touch screen reads the file in the viewer, read only: Monaco has no touch support.
    const touch = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const phone = await touch.newPage();
      const t = await openTile(phone);
      expect(await phone.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await t.row("data").click();
      await t.row("data/e2e").click();
      await t.row(dir).click();
      await t.row(file).click();
      await expect(t.code).toContainText("export const a = 3;");
      await expect(t.editor).toHaveCount(0);
    } finally {
      await touch.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
