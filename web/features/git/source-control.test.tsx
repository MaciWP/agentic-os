import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderWith } from "../../test-render.tsx";
import { type Pick, resolvePick } from "./changes.ts";
import type { GitStatus } from "./queries.ts";
import { SourceControl } from "./source-control.tsx";
import { SyncNote } from "./sync-note.tsx";
import { status } from "./test-fixtures.ts";

const column = (s: GitStatus, pick: Pick | null = null) =>
  renderWith(<SourceControl location="repo:alpha" s={s} pick={pick} onPick={() => {}} />);

const between = (html: string, from: string, to?: string) =>
  html.slice(html.indexOf(from), to ? html.indexOf(to) : undefined);

describe("SourceControl", () => {
  test("branch, upstream and counts; files by group as a tree, each with its actions", async () => {
    const html = await column(status(), { path: "src/a.txt", staged: false });
    expect(html).toContain(">main<");
    expect(html).toContain("→ origin/main");
    expect(html).toContain("1 commit por delante, 2 commits por detrás");
    const staged = between(html, 'aria-label="Preparados"', 'aria-label="Cambios"');
    expect(staged).toContain('aria-label="both.txt, modificado"');
    expect(staged).toContain('aria-label="new name.txt, renombrado"');
    expect(staged).toContain("← old name.txt");
    expect(staged).toContain('aria-label="Quitar both.txt de lo preparado"');
    expect(staged).toContain('aria-label="Quitar todo en Preparados de lo preparado"');
    expect(staged).not.toContain("src/a.txt");
    const unstaged = between(html, 'aria-label="Cambios"', 'aria-label="Sin seguimiento"');
    // The tree: a folder row, then the file by its name under it.
    expect(unstaged).toMatch(/>src<.*aria-label="src\/a.txt, modificado"/s);
    expect(unstaged).toContain('aria-label="Preparar src/a.txt"');
    expect(unstaged).toContain('aria-label="Descartar cambios de src/a.txt"');
    expect(unstaged).not.toContain("fresh/x.txt");
    expect(unstaged).toMatch(/aria-pressed="true"[^>]*aria-label="src\/a.txt, modificado"/);
    // New files have their own group: staged or left there, never discarded from here.
    const untracked = between(html, 'aria-label="Sin seguimiento"', 'aria-label="Commit"');
    expect(untracked).toContain('aria-label="fresh/x.txt, nuevo"');
    expect(untracked).toContain('aria-label="Preparar fresh/x.txt"');
    expect(untracked).toContain('aria-label="Preparar todo en Sin seguimiento"');
    expect(untracked).not.toContain("Descartar");
    expect(untracked).not.toContain("de lo preparado");
  });

  test("a staged new file is in Preparados, and only there", async () => {
    const html = await column(
      status({ files: [{ path: "fresh/x.txt", orig: null, x: "A", y: ".", kind: "changed" }] }),
    );
    expect(html).toContain('aria-label="Quitar fresh/x.txt de lo preparado"');
    expect(html).not.toContain('aria-label="Sin seguimiento"');
    expect(html).not.toContain('aria-label="Cambios"');
  });

  test("conflicts come first and are marked resolved, not staged; commit waits for them", async () => {
    const html = await column(
      status({
        truncated: true,
        files: [{ path: "both.ts", orig: null, x: "U", y: "U", kind: "conflict" }],
      }),
    );
    const conflicts = between(html, 'aria-label="En conflicto"', 'aria-label="Commit"');
    expect(conflicts).toContain('aria-label="both.ts, en conflicto"');
    expect(conflicts).toContain('aria-label="Marcar both.ts como resuelto"');
    expect(conflicts).not.toContain('aria-label="Preparar both.ts"');
    expect(html).toContain("se muestran los primeros 1");
    expect(html).toContain('title="Resuelve los conflictos antes del commit."');
  });

  test("the commit button counts what is staged and says why it is off", async () => {
    const some = await column(status());
    expect(some).toContain("Commit (2)");
    expect(some).toContain('title="Escribe el mensaje del commit."');
    const none = await column(status({ files: [status().files[0] as GitStatus["files"][number]] }));
    expect(none).toContain("Commit (0)");
    expect(none).toContain("Prepara ficheros para el commit.");
    const clean = await column(status({ files: [], ahead: 0, behind: 0 }));
    expect(clean).toContain("el árbol de trabajo está limpio");
    expect(clean).not.toContain("por delante");
  });

  test("fetch with an upstream; fast-forward when behind; push when ahead or unpublished", async () => {
    const both = await column(status());
    expect(both).toContain(">Buscar cambios<");
    expect(both).toContain(">Avanzar<");
    expect(both).toContain(">Subir<");
    const even = await column(status({ behind: 0, ahead: 0 }));
    expect(even).toContain(">Buscar cambios<");
    expect(even).not.toContain(">Avanzar<");
    expect(even).not.toContain(">Subir<");
    const alone = await column(status({ upstream: null, ahead: null, behind: null }));
    expect(alone).not.toContain("Buscar cambios");
    expect(alone).toContain(">Publicar rama<");
    const detached = await column(status({ branch: null, upstream: null }));
    expect(detached).toContain("HEAD separado");
    expect(detached).not.toContain(">Avanzar<");
    expect(detached).not.toContain("Publicar rama");
    expect(detached).not.toContain("sin upstream");
  });
});

describe("resolvePick", () => {
  test("the same side, then the same path on the other side, then the first file", () => {
    const s = status();
    expect(resolvePick(s, { path: "both.txt", staged: false })).toEqual({
      path: "both.txt",
      staged: false,
    });
    expect(resolvePick(s, { path: "new name.txt", staged: false })).toEqual({
      path: "new name.txt",
      staged: true,
    });
    expect(resolvePick(s, { path: "gone", staged: false })).toEqual({
      path: "both.txt",
      staged: true,
    });
    expect(resolvePick(status({ files: [] }), null)).toBeNull();
  });
});

describe("SyncNote", () => {
  const note = (p: Parameters<typeof SyncNote>[0]) => renderToStaticMarkup(<SyncNote {...p} />);
  const pulled = { branch: "main", from: "1111111aaaa", to: "2222222bbbb", submodules: null };

  test("says what the fetch, the fast-forward or the push did", () => {
    expect(note({ op: undefined, result: undefined, error: null })).toBe("");
    expect(note({ op: "fetch", result: null, error: null })).toContain("Remoto consultado");
    const moved = note({
      op: "pull",
      result: { ...pulled, result: "updated", commits: 2 },
      error: null,
    });
    expect(moved).toContain('role="status"');
    expect(moved).toContain("main avanzada 2 commits: 1111111 → 2222222.");
    const even = note({
      op: "pull",
      result: { ...pulled, result: "up_to_date", commits: 0 },
      error: null,
    });
    expect(even).toContain("main ya estaba al día con su upstream.");
    const pushed = { branch: "main", remote: "origin", upstreamSet: false, commits: 3 };
    expect(note({ op: "push", result: pushed, error: null })).toContain(
      "main subida a origin: 3 commits.",
    );
    expect(note({ op: "push", result: { ...pushed, upstreamSet: true }, error: null })).toContain(
      "main publicada en origin; ahora la sigue.",
    );
  });

  test("a refusal is an alert in the server's own words", () => {
    const html = note({
      op: "pull",
      result: undefined,
      error: new Error("Hay 1 fichero cambiado"),
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("No avanza: Hay 1 fichero cambiado");
    expect(note({ op: "fetch", result: undefined, error: new Error("x") })).toContain(
      "No se han podido buscar cambios: x",
    );
    expect(note({ op: "push", result: undefined, error: new Error("y") })).toContain(
      "No se ha subido: y",
    );
  });
});
