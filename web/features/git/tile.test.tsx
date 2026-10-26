import { describe, expect, test } from "bun:test";
import { failQuery, renderWith } from "../../test-render.tsx";
import { memoryStorage } from "../../test-storage.ts";
import { terminal } from "../terminals/test-fixtures.ts";
import { status } from "./test-fixtures.ts";
import { GitView } from "./tile.tsx";

const DIFF = [
  "diff --git a/src/a.txt b/src/a.txt",
  "index 1111111..2222222 100644",
  "--- a/src/a.txt",
  "+++ b/src/a.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+TWO",
  "",
].join("\n");

const one = () =>
  status({ files: [{ path: "src/a.txt", orig: null, x: ".", y: "M", kind: "changed" }] });

const diffOf = (diff: string) => ({
  diff,
  truncated: false,
  note: null,
  hunkable: true,
  hunks: ["a".repeat(40)],
});

const tile = (diff: unknown, s: unknown = one()) =>
  renderWith(<GitView location="repo:alpha" lead={<span>1</span>} />, [
    [["projects", "git", "status", "repo:alpha"], s],
    [["projects", "git", "diff", "repo:alpha", "src/a.txt", false], diff],
  ]);

describe("GitView", () => {
  test("a failed poll keeps the list and the diff on screen, with a warning", async () => {
    const view = (key: unknown[], data?: unknown) =>
      renderWith(
        <GitView location="repo:alpha" lead={<span>1</span>} />,
        [
          [["projects", "git", "status", "repo:alpha"], one()],
          [["projects", "git", "diff", "repo:alpha", "src/a.txt", false], diffOf(DIFF)],
        ],
        failQuery(key, data, "git gone"),
      );
    const status = ["projects", "git", "status", "repo:alpha"];
    const kept = await view(status, one());
    expect(kept).toContain("lo que ves puede estar desfasado: git gone");
    expect(kept).toContain("TWO");
    expect(kept).not.toContain("No se han podido cargar los datos");
    const diff = ["projects", "git", "diff", "repo:alpha", "src/a.txt", false];
    const stale = await view(diff, diffOf(DIFF));
    expect(stale).toContain("lo que ves puede estar desfasado: git gone");
    expect(stale).toContain("TWO");
    // Never read: nothing to keep.
    expect(await view(diff)).toContain("No se han podido cargar los datos");
  });

  test("a header like a terminal's, the column beside the first file's diff", async () => {
    const html = await tile({
      diff: DIFF,
      truncated: false,
      note: null,
      hunkable: true,
      hunks: ["a".repeat(40)],
    });
    expect(html).toContain('data-harness="git"');
    expect(html).toContain(">repo:alpha<");
    expect(html).toContain('aria-label="Actualizar"');
    expect(html).toContain('aria-label="Control de versiones de repo:alpha"');
    expect(html).toContain('aria-label="Diff de src/a.txt"');
    expect(html).toContain('<span class="text-ok">+1</span>');
    expect(html).toContain(">Preparar hunk<");
    // The changed word is marked inside its line.
    expect(html).toMatch(/bg-ok\/35[^>]*>TWO</);
    expect(html).toMatch(/bg-bad\/35[^>]*>two</);
  });

  test("a narrow tile starts on the list; the diff and its way back show once a file is picked", async () => {
    const html = await tile({
      diff: DIFF,
      truncated: false,
      note: null,
      hunkable: false,
      hunks: [],
    });
    expect(html).toMatch(/<aside[^>]*class="[^"]*@\[44rem\]:block[^"]*\bblock\b/);
    expect(html).toMatch(/<main[^>]*class="[^"]*@\[44rem\]:flex[^"]*\bhidden\b/);
    expect(html).toMatch(/@\[44rem\]:hidden[^>]*>.*Ficheros</s);
  });

  test("a truncated diff offers no hunk; not a repo; no location", async () => {
    const cut = await tile({ diff: DIFF, truncated: true, note: null, hunkable: false, hunks: [] });
    expect(cut).toContain("Diff recortado a 512 KB");
    expect(cut).not.toContain("Preparar hunk");
    expect(await tile(null, { repo: false })).toContain("No es un repo de git");
    expect(await renderWith(<GitView location={null} />)).toContain("no dice de qué checkout es");
  });

  test("kept notes show under their lines, as a badge on the file and in the send bar", async () => {
    const note = (over: object) => ({
      id: "n1",
      path: "src/a.txt",
      staged: false,
      lines: ["+TWO"],
      side: "new",
      start: 2,
      end: 2,
      kind: "keep",
      text: "Déjalo así",
      created: 0,
      sent: null,
      ...over,
    });
    const disk = memoryStorage("local", {
      "aos.diff-notes:repo:alpha": JSON.stringify([
        note({}),
        // Its line is no longer in the diff: it shows above it, touched.
        note({ id: "n2", lines: ["+three"], kind: "nit", text: "Fuera", sent: Date.now() }),
      ]),
    });
    try {
      const terminals = (list: unknown[]) => ({
        terminals: list,
        locations: [],
        openFolder: false,
      });
      const view = (list: unknown[]) =>
        renderWith(<GitView location="repo:alpha" lead={<span>1</span>} />, [
          [["projects", "git", "status", "repo:alpha"], one()],
          [["projects", "git", "diff", "repo:alpha", "src/a.txt", false], diffOf(DIFF)],
          [["terminals"], terminals(list)],
        ]);
      const html = await view([
        terminal({ id: "c1", harness: "claude", location: "repo:alpha" }),
        terminal({ id: "s1", harness: "shell", location: "repo:alpha" }),
        terminal({ id: "c2", harness: "codex", location: "repo:beta" }),
      ]);
      expect(html).toContain('data-note="n1"');
      expect(html).toContain("no tocar");
      expect(html).toContain("Déjalo así");
      expect(html).toContain('aria-label="Notas sobre líneas que ya no están"');
      expect(html).toMatch(/data-note="n2"[\s\S]*tocada/);
      expect(html).toContain('aria-label="src/a.txt, modificado, 1 nota sin enviar"');
      // Only the agent in this checkout is offered; a shell and another checkout's agent are not.
      expect(html).toContain('<option value="c1" selected="">Claude</option>');
      expect(html).not.toContain('value="s1"');
      expect(html).not.toContain('value="c2"');
      expect(html).toContain(">Enviar 1<");
      expect(html).toContain("Limpiar enviadas");

      const none = await view([terminal({ id: "s1", harness: "shell", location: "repo:alpha" })]);
      expect(none).toContain("no hay ningún agente en marcha en este checkout");
      expect(none).toMatch(/disabled=""[^>]*>Enviar 1</);
    } finally {
      disk.restore();
    }
  });
});
