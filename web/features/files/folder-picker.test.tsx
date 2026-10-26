import { describe, expect, test } from "bun:test";
import { failQuery, renderWith } from "../../test-render.tsx";
import { FolderPicker, type FolderPickerProps } from "./folder-picker.tsx";
import type { FolderEntry, Listing } from "./queries.ts";

const home = "/Users/me";
const repos = "/Users/me/repos";
const places = {
  home,
  places: [
    { id: "repos", label: "Repos", path: repos },
    { id: "home", label: "Inicio", path: home },
  ],
};
const entry = (name: string, git = false): FolderEntry => ({
  name,
  path: `${repos}/${name}`,
  kind: "folder",
  git,
});
const listing = (over: Partial<Listing> = {}): Listing => ({
  path: repos,
  parent: home,
  git: false,
  entries: [entry("api", true), entry("notes")],
  truncated: false,
  ...over,
});

const noop = () => {};
const picker = (props: Partial<FolderPickerProps> = {}) => (
  <FolderPicker action="Añadir este repo" onPick={noop} onCancel={noop} {...props} />
);
const render = (props: Partial<FolderPickerProps>, l: Listing | null = listing()) =>
  renderWith(picker(props), [
    [["files", "places"], places],
    ...(l ? [[["files", "folders", l.path], l] as [unknown[], unknown]] : []),
  ]);

const actionButton = (html: string) => html.match(/<button[^>]*>Añadir este repo<\/button>/)?.[0];

describe("FolderPicker", () => {
  test("starts at the first place, with its folders, the marks and ~ for home", async () => {
    const html = await render({
      mark: (e) => (e.git ? <span className="pill">git</span> : null),
    });
    expect(html).toContain('value="~/repos/"');
    expect(html).toContain('aria-label="Carpetas"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toContain("api</span>");
    expect(html).toContain('<span class="pill">git</span>');
    // The place shown is marked; the other is not.
    expect(html).toMatch(/aria-current="true" title="~\/repos"/);
    expect(html).not.toMatch(/aria-current="true" title="~"/);
  });

  test("a folder that cannot be picked says why, and the action waits", async () => {
    const check = (l: Listing) => (l.git ? null : "Elige la raíz de un repo de git.");
    const refused = await render({ check });
    expect(refused).toContain("Elige la raíz de un repo de git.");
    expect(actionButton(refused)).toContain("disabled");
    const ok = await render(
      { check, start: `${repos}/api` },
      listing({ path: `${repos}/api`, git: true }),
    );
    expect(ok).not.toContain("Elige la raíz");
    expect(actionButton(ok)).not.toContain("disabled");
    expect(await render({ busy: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Un momento…<\/button>/,
    );
  });

  test("a folder that cannot be read shows the server's words over the last good one", async () => {
    const html = await renderWith(picker(), [[["files", "places"], places]], (client) =>
      failQuery(
        ["files", "folders", repos],
        listing(),
        "macOS no deja leer /Users/me/repos.",
      )(client),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("macOS no deja leer /Users/me/repos.");
    expect(html.match(/role="option"/g)).toHaveLength(2);
  });

  test("says when a folder is empty or cut, and shows the caller's failure", async () => {
    expect(await render({}, listing({ entries: [] }))).toContain("Sin subcarpetas.");
    expect(await render({}, listing({ truncated: true }))).toContain(
      "Hay más de 2000 carpetas: escribe la ruta.",
    );
    const failed = await render({ error: new Error("La carpeta se solapa con api.") });
    expect(failed).toMatch(/role="alert"[^>]*>La carpeta se solapa con api\./);
  });

  test("at the root there is nowhere to go up", async () => {
    const html = await render({ start: "/" }, listing({ path: "/", parent: null }));
    expect(html).toContain('value="/"');
    expect(html).toMatch(/aria-label="Subir a la carpeta de arriba"[^>]*disabled/);
  });
});
