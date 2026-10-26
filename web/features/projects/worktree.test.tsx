import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { NewWorktreeForm, WorktreeActions } from "./worktree.tsx";

const ok = { error: null };
const actions = (
  kind: "repo" | "worktree",
  removable: boolean,
  setup: { error: string | null } = ok,
) =>
  renderWith(
    <WorktreeActions
      kind={kind}
      repo="alpha"
      node={kind === "repo" ? "repo:alpha" : "wt:alpha:fix"}
      removable={removable}
      setup={setup}
      pushRight={false}
    />,
  );

describe("worktree actions in a row's ⋯", () => {
  test("a repo offers a new worktree, closed until clicked", async () => {
    const html = await actions("repo", false);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Nuevo worktree</);
    expect(html).not.toContain("Quitar worktree");
    expect(html).not.toContain("<form");
  });

  test("without a usable root the reason shows instead of the button", async () => {
    const html = await actions("repo", false, { error: "El perfil no tiene worktrees.root." });
    expect(html).toContain("Nuevo worktree no disponible. El perfil no tiene worktrees.root.");
    expect(html).not.toContain(">Nuevo worktree<");
  });

  test("only a worktree the app made can be removed", async () => {
    expect(await actions("worktree", true)).toContain(">Quitar worktree<");
    expect(await actions("worktree", false)).toBe("");
  });
});

describe("NewWorktreeForm", () => {
  const branches = {
    local: ["refs/heads/main", "refs/heads/feat/a"],
    remote: ["refs/remotes/origin/main", "refs/remotes/origin/feat/b", "refs/remotes/fork/x"],
    base: "refs/remotes/origin/main",
  };
  const form = (data: unknown) =>
    renderWith(<NewWorktreeForm repo="alpha" onDone={() => {}} />, [
      [["projects", "branches", "alpha"], data],
    ]);

  test("suggests local and origin branch names once, and starts from the remote default", async () => {
    const html = await form(branches);
    const list = html.slice(html.indexOf("<datalist"), html.indexOf("</datalist>"));
    expect([...list.matchAll(/value="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "main",
      "feat/a",
      "feat/b",
    ]);
    expect(html).toMatch(/<option value="refs\/remotes\/origin\/main" selected="">origin\/main</);
    expect(html).toContain('<option value="refs/heads/feat/a">feat/a</option>');
    expect(html).toContain('<option value="refs/remotes/fork/x">fork/x</option>');
    expect(html).toContain("Una rama que ya existe se abre tal cual");
    // Nothing typed yet: nothing to create.
    expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  });

  test("without a known default the base asks for the remote's own", async () => {
    const html = await form({ ...branches, base: null });
    expect(html).toMatch(/<option value="" selected="">Base por defecto del remoto</);
  });

  test("while the branches load, the base waits", async () => {
    const html = await renderWith(<NewWorktreeForm repo="alpha" onDone={() => {}} />);
    expect(html).toMatch(/aria-label="Base"[^>]*disabled=""/);
    expect(html).toContain("Cargando ramas…");
  });
});
