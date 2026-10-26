import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { failQuery, renderWith } from "../../test-render.tsx";
import { memoryStorage } from "../../test-storage.ts";
import { gitSummaryQuery } from "../git/queries.ts";
import { ticket } from "../home/test-fixtures.ts";
import type { TerminalInfo } from "../terminals/queries.ts";
import { terminal } from "../terminals/test-fixtures.ts";
import { usualBranch } from "./env-node.tsx";
import { envState, findNode, groupTerminals, type Projects } from "./queries.ts";
import { projects } from "./test-fixtures.ts";
import { ProjectsTree, type Selection } from "./tree.tsx";
import type { Env } from "./tree-types.ts";
import { UpdateLines } from "./update-lines.tsx";

function render(
  p: Projects | null,
  terminals: TerminalInfo[] | null = [],
  selected: Selection = {},
) {
  const data: [unknown[], unknown][] = [];
  if (p) data.push([["projects"], p]);
  if (terminals) data.push([["terminals"], { terminals, locations: [] }]);
  return renderWith(<ProjectsTree selected={selected} />, data);
}

describe("groupTerminals", () => {
  test("puts each terminal under the node of its location, env commands under their env", () => {
    const at = (id: string, location: string, over: Partial<TerminalInfo> = {}) =>
      terminal({ id, location, ...over });
    const { byNode, loose } = groupTerminals(
      [
        at("1", "env:env-a"),
        at("2", "env:env-a/p-backend"),
        at("3", "envs", { harness: "env", env: "env-a" }),
        at("4", "repo:alpha"),
        at("5", "wt:alpha:fix"),
        at("6", "app"),
        // Nodes that are gone: a removed worktree, an env no longer listed.
        at("7", "wt:alpha:gone"),
        at("8", "env:env-z/p-backend"),
        // Env commands with no env node: a new env's create, one on every env. Loose too.
        at("9", "envs", { harness: "env", env: "env-new", action: "create" }),
        at("10", "envs", { harness: "env", env: null, action: "doctor" }),
      ],
      projects(),
    );
    const ids = (key: string) => byNode.get(key)?.map((t) => t.id);
    expect(ids("env:env-a")).toEqual(["1", "3"]);
    expect(ids("env:env-a/p-backend")).toEqual(["2"]);
    expect(ids("repo:alpha")).toEqual(["4"]);
    expect(ids("wt:alpha:fix")).toEqual(["5"]);
    expect(byNode.has("envs")).toBe(false);
    expect(loose.map((t) => t.id)).toEqual(["6", "7", "8", "9", "10"]);
  });

  test("without an env provider, env commands have no node of their own", () => {
    const { byNode, loose } = groupTerminals(
      [terminal({ location: "envs", harness: "env", env: null })],
      projects({ configured: false, items: [] }),
    );
    expect(byNode.has("envs")).toBe(false);
    expect(loose).toHaveLength(1);
  });

  test("with the env provider failing, terminals in envs stay in sight as loose ones", () => {
    const { loose } = groupTerminals(
      [terminal({ location: "env:env-a/p-backend" })],
      projects({ items: [], error: "list exited with 1" }),
    );
    expect(loose).toHaveLength(1);
  });

  test("a Claude in the free folder has its own place, not the loose ones", () => {
    const { byNode, loose } = groupTerminals([terminal({ location: "scratch" })], projects());
    expect(byNode.get("scratch")).toHaveLength(1);
    expect(loose).toHaveLength(0);
  });
});

describe("findNode", () => {
  test("name each node with the tree's full label, and the app node holds the loose ones", () => {
    const p = projects();
    expect(findNode(p, "env:env-a")).toEqual({ label: "env-a", kind: "env", canLaunch: true });
    expect(findNode(p, "env:env-a/p-backend")?.label).toBe("env-a/p-backend");
    expect(findNode(p, "repo:alpha")?.kind).toBe("repo");
    expect(findNode(p, "wt:alpha:fix")?.label).toBe("alpha/fix");
    expect(findNode(p, "app")?.label).toBe("Agentic OS");
    expect(findNode(p, "scratch")).toEqual({
      label: "Carpeta libre",
      kind: "scratch",
      canLaunch: true,
    });
    expect(findNode(p, "wt:alpha:gone")).toBeNull();
    // The envs as a whole are the Entornos header's buttons, not a node.
    expect(findNode(p, "envs")).toBeNull();
  });
});

// Envs and repos start folded; these tests read what is inside them, so the fixture's nodes
// are kept open, as a click on each chevron would leave them.
const UNFOLDED = {
  "node:envs": true,
  "node:env:env-a": true,
  "node:repo-group:alpha": true,
  "node:repo-group:beta": true,
};
let restore = () => {};
const keep = (open: Record<string, boolean>) => {
  restore();
  restore = memoryStorage("local", { "aos.tree.open": JSON.stringify(open) }).restore;
};

describe("ProjectsTree", () => {
  beforeEach(() => keep(UNFOLDED));
  afterEach(() => {
    restore();
    restore = () => {};
  });

  test("envs and repos start folded: the row keeps the state, its commands and what runs inside", async () => {
    keep({});
    const html = await render(projects(), [
      terminal({ id: "1", location: "env:env-a/p-backend", cwd: "/envs/env-a/p-backend" }),
      terminal({ id: "2", location: "env:env-a", harness: "env", env: "env-a", action: "logs" }),
    ]);
    expect(html).toContain('aria-label="Desplegar env-a"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/bg-ok\/15[^>]*>.*?<span class="sr-only">levantado<\/span>/);
    expect(html).toContain('aria-label="Parar env-a"');
    // The web hangs from its checkout, out of sight while the env is folded.
    expect(html).not.toContain('aria-label="Abrir la web de env-a/p-backend"');
    // Both terminals run inside the env: one in it, one in its checkout.
    expect(html).toContain('title="2 en marcha dentro"');
    expect(html).toMatch(/2<span class="sr-only"> en marcha<\/span>/);
    expect(html).not.toContain("Terminales en env-a/p-backend");
    expect(html).toContain('aria-label="Desplegar alpha"');
    expect(html).not.toContain("Terminales en alpha/fix");
    // The sections stay open.
    expect(html).toContain('aria-label="Plegar Entornos"');
  });

  test("a node a link points at unfolds the env holding it, and is marked", async () => {
    keep({});
    const html = await render(projects(), [], { node: "env:env-a/p-backend" });
    expect(html).toContain('aria-label="Plegar env-a"');
    expect(html).toMatch(
      /<div data-node="env:env-a\/p-backend" data-marked="true" aria-current="true"/,
    );
    // Unfolded once, not pinned: the env can be folded again.
    expect(html).toMatch(/aria-expanded="true"[^>]*aria-label="Plegar env-a"/);
  });

  test("a section folded by hand opens for the node a link points at; the others stay folded", async () => {
    keep({ "block:Entornos": false, "block:Work": false });
    const html = await render(projects(), [], { node: "repo:alpha" });
    expect(html).toContain('aria-label="Plegar Work"');
    expect(html).toMatch(/<div data-node="repo:alpha" data-marked="true" aria-current="true"/);
    expect(html).toContain('aria-label="Desplegar Entornos"');
    expect(html).not.toContain('data-node="env:env-a"');
  });

  test("an env shows no ticket summary, and a branch only on a checkout off the usual one", async () => {
    const html = await renderWith(<ProjectsTree />, [
      [["projects"], projects()],
      [["terminals"], { terminals: [], locations: [] }],
      [
        ["tickets"],
        { jql: "q", tickets: [{ ...ticket("ABC-1", "new"), summary: "Arreglar el login" }] },
      ],
    ]);
    // The summary shows in the rail's «Tickets» tab only, never under the env.
    expect(html).not.toContain("Arreglar el login");
    const c = (branch: string | null) => ({ branch });
    expect(usualBranch({ checkouts: [c("a"), c("a"), c("b")] as Env["checkouts"] })).toBe("a");
    expect(usualBranch({ checkouts: [c("a"), c("b")] as Env["checkouts"] })).toBeNull();
    expect(usualBranch({ checkouts: [c(null)] as Env["checkouts"] })).toBeNull();
  });

  test("no node lists its terminals: it says how many run, the Mesa list holds them", async () => {
    const html = await render(projects(), [
      terminal({ id: "1", location: "env:env-a", harness: "env", env: "env-a", action: "logs" }),
      terminal({ id: "2", location: "repo:alpha", cwd: "/src/alpha" }),
      terminal({ id: "3", location: "repo:alpha", cwd: "/src/alpha", state: "exited" }),
    ]);
    expect(html).not.toContain("Terminales en");
    expect(html).not.toMatch(/aria-label="Parar (Claude|Logs)/);
    const row = (node: string) => {
      const at = html.indexOf(`data-node="${node}"`);
      return html.slice(at, html.indexOf("</div>", at));
    };
    expect(row("env:env-a")).toContain('title="1 en marcha dentro"');
    // An ended terminal is not counted.
    expect(row("repo:alpha")).toContain('title="1 en marcha dentro"');
  });

  test("shows envs with their checkouts and repos with their worktrees, each row markable", async () => {
    const html = await render(projects());
    // Every checkout is on the usual branch, so no row says it; the env's title does.
    expect(html).not.toContain(">ABC-1<");
    expect(html).toContain('title="Rama: ABC-1\nMárcalo y ábrelo con la barra de arriba"');
    // The web hangs from the checkout of its repo; the env lists no hosts.
    expect(html).toContain('aria-label="Abrir la web de env-a/p-backend"');
    expect(html).toContain('href="https://front-env-a.test"');
    expect(html).not.toContain('href="https://env-a.test');
    // Its servers as a dot: the state and the provider's line per repo on hover.
    expect(html).toContain('title="levantado\nbackend · Docker up · servidores 2/2\ncontract"');
    // Its commands in a line under it, on hover or focus: start or stop by word, the rest icons.
    const strip = html.match(/<div role="group" aria-label="Acciones de env-a".*?<\/div>/)?.[0];
    expect(strip).toContain("group-hover/node:flex");
    expect(strip).toContain('aria-label="Parar env-a"');
    expect(strip).not.toContain('aria-label="Levantar env-a"');
    for (const name of ["Actualizar env-a", "Logs env-a", "Ver salida", "Borrar entorno…"])
      expect(strip).toContain(`aria-label="${name}"`);
    expect(html).not.toContain(">contract<");
    // No launch on the rows: each is marked, and the bar above opens there.
    expect(html).toContain('aria-label="Marcar env-a/p-backend"');
    expect(html).toContain('aria-label="Marcar alpha/fix"');
    expect(html).toContain('aria-label="Marcar Agentic OS"');
    expect(html).not.toMatch(/aria-label="Claude en [^"]*"[^>]*><svg[^>]*lucide-plus/);
    // A detached worktree shows, and cannot be marked.
    expect(html).toContain("sin rama");
    expect(html).not.toContain('aria-label="Marcar alpha/old"');
    expect(html).toContain("git exited with 128: x");
  });

  test("an env whose checkouts sit on different branches names each on its checkout only", async () => {
    const p = projects();
    const env = p.envs.items[0];
    if (!env) throw new Error("fixture");
    env.branch = "backend@x · web@y";
    env.checkouts = [
      { ...env.checkouts[0], dir: "p-backend", branch: "x" } as (typeof env.checkouts)[number],
      {
        dir: "p-web",
        location: "env:env-a/p-web",
        repo: null,
        branch: "y",
        link: null,
      },
    ];
    const html = await render(p);
    expect(html).not.toContain("backend@x");
    expect(html.match(/>x</g)).toHaveLength(1);
    expect(html.match(/>y</g)).toHaveLength(1);
  });

  test("the bar above the tree opens its tools in the marked row, kept in this browser", async () => {
    const bar = (html: string) =>
      html.match(/<fieldset aria-label="Abrir en la fila marcada".*?<\/fieldset>/)?.[0] ?? "";
    // Nothing marked: every tool waits for a row.
    const none = bar(await render(projects()));
    for (const name of ["Claude", "Codex", "Grok", "Shell", "Git", "Código"])
      expect(none).toMatch(new RegExp(`aria-label="${name}" title="Marca abajo[^"]*" disabled=""`));
    restore();
    restore = memoryStorage("local", {
      "aos.tree.open": JSON.stringify(UNFOLDED),
      "aos.projects.picked": "wt:alpha:fix",
    }).restore;
    const html = await render(projects());
    expect(bar(html)).toContain('aria-label="Codex en alpha/fix"');
    expect(bar(html)).not.toMatch(/aria-label="Codex en alpha\/fix"[^>]*disabled/);
    expect(html).toMatch(/aria-pressed="true" aria-label="Marcar alpha\/fix"/);
    // An env root is no checkout: no git there.
    const env = bar(await render(projects(), [], { node: "env:env-a" }));
    expect(env).toMatch(/aria-label="Git en env-a" title="Sin git[^"]*" disabled=""/);
    expect(env).not.toMatch(/aria-label="Shell en env-a"[^>]*disabled/);
  });

  test("while the tree loads or fails it says so, and lists no terminals of its own", async () => {
    const running = [terminal({ id: "1", location: "env:env-a/p-backend", cwd: "/e/env-a/back" })];
    const loading = await render(null, running);
    expect(loading).toContain('aria-busy="true"');
    // A failed query with no data; renderWith keeps it from retrying on mount.
    const failing = await renderWith(
      <ProjectsTree />,
      [[["terminals"], { terminals: running, locations: [] }]],
      (client) =>
        client
          .getQueryCache()
          .build(client, { queryKey: ["projects"] })
          .setState({ status: "error", error: new Error("route down"), fetchStatus: "idle" }),
    );
    expect(failing).toContain("route down");
    expect(failing).not.toContain('aria-label="Parar Claude');
  });

  test("a name marks its row, a heading's name folds it; the node a link points at is marked", async () => {
    const html = await render(projects(), [], { node: "env:env-a" });
    // No node is a link any more.
    expect(html).not.toContain('href="/terminales?node=');
    expect(html).toMatch(
      /<button type="button"[^>]*aria-pressed="true" aria-label="Marcar env-a"[^>]*><span[^>]*>env-a<\/span><\/button>/,
    );
    // A repo heading marks its main checkout, and unfolds it.
    expect(html).toMatch(
      /<button type="button"[^>]*aria-pressed="false" aria-label="Marcar alpha\/[^"]+ desde alpha"[^>]*><span[^>]*>alpha<\/span><\/button>/,
    );
    expect(html).toMatch(/<div data-node="env:env-a" data-marked="true" aria-current="true"/);
    expect(html.match(/data-node="[^"]*"( data-marked="true")? aria-current/g)).toHaveLength(1);
  });

  test("«⋯» shows on the rows that have more to do: repos and worktrees the app made", async () => {
    const html = await render(projects());
    // An env's commands are its line under the row instead.
    expect(html).not.toContain('aria-label="Más acciones en env-a"');
    expect(html).toContain('aria-label="Más acciones en alpha"');
    expect(html).toContain('aria-label="Más acciones en alpha/fix"');
    expect(html).not.toContain('aria-label="Más acciones en env-a/p-backend"');
    expect(html).not.toContain('aria-label="Más acciones en Agentic OS"');
    expect(html).not.toContain('aria-label="Más acciones en alpha/old"');
  });

  test("each checkout shows its git counts beside its name; one without them shows none", async () => {
    const html = await renderWith(<ProjectsTree />, [
      [["projects"], projects()],
      [["terminals"], { terminals: [], locations: [] }],
      [
        ["projects", "git", "summary"],
        {
          items: {
            "repo:alpha": { branch: "main", ahead: 0, behind: 3, changed: 2, truncated: false },
            "env:env-a/p-backend": {
              branch: "ABC-1",
              ahead: 1,
              behind: 0,
              changed: 0,
              truncated: false,
            },
            "wt:alpha:fix": { branch: "fix", ahead: 0, behind: 0, changed: 0, truncated: false },
          },
        },
      ],
    ]);
    const row = (node: string) => {
      const at = html.indexOf(`data-node="${node}"`);
      return html.slice(at, html.indexOf("</div>", at));
    };
    expect(row("repo:alpha")).toContain("↓3 · 2 cambios");
    expect(row("env:env-a/p-backend")).toContain("1 commit por delante");
    expect(row("wt:alpha:fix")).not.toContain("cambio");
    expect(row("wt:alpha:fix")).not.toContain("↑");
  });

  test("loading, failing and disabled each say what they are", async () => {
    expect(await render(null)).toContain('aria-busy="true"');
    expect(await render(projects({ error: "list exited with 1", items: [] }))).toContain(
      "El proveedor de entornos ha fallado",
    );
    expect(await render(projects({ configured: false, items: [] }))).toContain(
      "El proveedor de entornos está desactivado en este perfil.",
    );
    expect(await render(projects({ items: [] }))).toContain("Ningún entorno todavía");
  });

  test("the Entornos header offers a new env and the check-up, even when the env list fails", async () => {
    for (const p of [projects(), projects({ items: [] }), projects({ error: "x", items: [] })]) {
      const html = await render(p);
      expect(html).toContain('aria-label="Nuevo entorno"');
      expect(html).toContain('aria-label="Diagnóstico"');
      expect(html).not.toContain("node=envs");
    }
    expect(await render(projects({ configured: false, items: [] }))).not.toContain(
      'aria-label="Nuevo entorno"',
    );
  });

  test("a repo heads its checkouts: main by its branch, then each worktree, each tagged", async () => {
    const html = await render(projects(), [
      terminal({ id: "1", location: "repo:alpha", cwd: "/src/alpha" }),
    ]);
    const row = (node: string) => {
      const at = html.indexOf(`data-node="${node}"`);
      return html.slice(at, html.indexOf("</div>", at));
    };
    // The heading holds the repo's actions and marks its main checkout.
    expect(row("repo-group:alpha")).toContain(">alpha</span>");
    expect(row("repo-group:alpha")).toContain('aria-label="Más acciones en alpha"');
    expect(row("repo-group:alpha")).toMatch(/aria-label="Marcar alpha\/[^"]+ desde alpha"/);
    // Main is a row of its own, named by its branch, launched like any checkout.
    expect(row("repo:alpha")).toContain(">main</span>");
    expect(row("repo:alpha")).toContain(">principal</span>");
    expect(row("repo:alpha")).toContain('aria-label="Marcar alpha/main"');
    expect(row("wt:alpha:fix")).toContain(">worktree</span>");
    // A repo git cannot read still has its main row, by the word.
    expect(row("repo:beta")).toContain(">principal</span>");
    // Folded, the heading says how many run in its checkouts.
    keep({});
    const folded = await render(projects(), [
      terminal({ id: "1", location: "repo:alpha", cwd: "/src/alpha" }),
      terminal({ id: "2", location: "wt:alpha:fix", cwd: "/wt/alpha/fix" }),
    ]);
    expect(folded).not.toContain('data-node="repo:alpha"');
    const head = folded.slice(folded.indexOf('data-node="repo-group:alpha"'));
    expect(head.slice(0, head.indexOf("</div>"))).toContain('title="2 en marcha dentro"');
  });

  test("once Agentic OS is a repo, its main row holds the loose terminals and no folder shows", async () => {
    const p = { ...projects(), app: { location: "repo:alpha", label: "alpha" } };
    const html = await render(
      p,
      [
        terminal({ id: "1", location: "app", cwd: "/src/alpha" }),
        terminal({ id: "2", location: "wt:alpha:gone", cwd: "/x" }),
      ],
      { node: "app" },
    );
    expect(html).not.toContain('data-node="app"');
    expect(html).toMatch(/<div data-node="repo:alpha" data-marked="true" aria-current="true"/);
    // The loose one too: its worktree is gone.
    const main = html.slice(html.indexOf('data-node="repo:alpha"'));
    expect(main.slice(0, main.indexOf("</div>"))).toContain('title="2 en marcha dentro"');
    expect(findNode(p, "app")?.label).toBe("alpha/main");
  });

  test("repos show under the section their config names; the rest under «Otros proyectos»", async () => {
    const html = await render(projects());
    const work = html.slice(
      html.indexOf('aria-label="Work"'),
      html.indexOf('aria-label="Otros proyectos"'),
    );
    const others = html.slice(html.indexOf('aria-label="Otros proyectos"'));
    expect(work).toContain('data-node="repo-group:alpha"');
    expect(work).toContain(">Actualizar repos<");
    expect(work).toContain('title="acme/alpha\n/src/alpha\nMárcalo');
    expect(others).toContain('data-node="repo:beta"');
    expect(others).toContain('data-node="app"');
    expect(others).toContain("Añadir repo");
    expect(others).not.toContain("Actualizar repos");
    // With no section named, the update goes with the other repos.
    const loose = await render({
      ...projects(),
      repos: projects().repos.map((r) => ({ ...r, group: null })),
    });
    expect(loose).not.toContain('aria-label="Work"');
    expect(loose.slice(loose.indexOf('aria-label="Otros proyectos"'))).toContain(
      ">Actualizar repos<",
    );
  });

  test("holds the places to work only: tickets and PRs have their own tabs in the rail", async () => {
    const html = await render(projects());
    expect(html.indexOf('aria-label="Otros proyectos"')).toBeGreaterThan(
      html.indexOf('aria-label="Work"'),
    );
    expect(html).not.toContain('aria-label="Tickets"');
    expect(html).not.toContain('aria-label="Pull requests"');
  });

  test("is a flat list: no cards, heads in sentence case, a section's dot and a repo's icon in its project's colour", async () => {
    const html = await render({ ...projects(), colors: { Work: "orange", beta: "teal" } });
    expect(html).not.toContain("border-l-2");
    expect(html).not.toContain("section-title");
    expect(html).toMatch(
      /<span aria-hidden="true" data-project-color="orange" class="size-2 [^"]*"><\/span><h3 class="font-semibold text-ink-2 text-\[12px\]">Work<\/h3>/,
    );
    // A repo of the section takes its colour; one of no section, its own.
    expect(html).toMatch(/data-node="repo-group:alpha".*?data-project-color="orange"/s);
    expect(html).toMatch(/data-node="repo-group:beta".*?data-project-color="teal"/s);
    expect(html).toMatch(
      /<h3 class="font-semibold text-ink-2 text-\[12px\]">Otros proyectos<\/h3>/,
    );
  });

  test("envs whose repos share a section nest in it, over its repos; elsewhere they stand apart", async () => {
    const pack = projects({ repos: ["alpha"] });
    const html = await render(pack);
    const work = html.slice(
      html.indexOf('aria-label="Work"'),
      html.indexOf('aria-label="Otros proyectos"'),
    );
    expect(html.indexOf('aria-label="Entornos"')).toBeGreaterThan(
      html.indexOf('aria-label="Work"'),
    );
    expect(work).toMatch(
      /aria-label="Entornos".*data-node="env:env-a".*aria-label="Repositorios"/s,
    );
    expect(work).toMatch(
      /aria-label="Repositorios".*>Actualizar repos<.*data-node="repo-group:alpha"/s,
    );
    expect(work).toContain('aria-label="Nuevo entorno"');
    expect(work).toMatch(/<h4 class="font-semibold text-ink-2 text-\[11px\]">Entornos<\/h4>/);
    // The fixture's envs check out repos of no section: Entornos is a section of its own.
    const apart = await render(projects());
    expect(apart.indexOf('aria-label="Entornos"')).toBeLessThan(apart.indexOf('aria-label="Work"'));
    expect(apart).not.toContain('aria-label="Repositorios"');
    // A link into an env unfolds the section that holds it, folded by hand.
    keep({ "block:Work": false, "block:Entornos": false });
    const linked = await render(pack, [], { node: "env:env-a/p-backend" });
    expect(linked).toContain('aria-label="Plegar Work"');
    expect(linked).toContain('aria-label="Plegar Entornos"');
    expect(linked).toMatch(
      /<div data-node="env:env-a\/p-backend" data-marked="true" aria-current="true"/,
    );
  });

  test("the Repos block offers to update them only when there are repos", async () => {
    expect(await render(projects())).toContain(">Actualizar repos<");
    expect(await render({ ...projects(), repos: [] })).not.toContain("Actualizar repos");
  });

  test("a failed git read is said, never shown as every checkout clean and in step", async () => {
    const html = await renderWith(
      <ProjectsTree />,
      [
        [["projects"], projects()],
        [["terminals"], { terminals: [], locations: [] }],
      ],
      failQuery(gitSummaryQuery.queryKey, undefined, "git timed out"),
    );
    expect(html).toContain(
      "Sin estado de git, los contadores de cambios no se muestran: git timed out",
    );
    expect(html).toContain(">Reintentar<");
    // A failed refresh after a good read keeps the old counts on screen: they are said stale.
    const stale = await renderWith(
      <ProjectsTree />,
      [
        [["projects"], projects()],
        [["terminals"], { terminals: [], locations: [] }],
      ],
      failQuery(
        gitSummaryQuery.queryKey,
        {
          items: {
            "repo:alpha": { branch: "main", ahead: 0, behind: 3, changed: 2, truncated: false },
          },
        },
        "git timed out",
      ),
    );
    expect(stale).toContain("↓3 · 2 cambios");
    expect(stale).not.toContain("no se muestran");
    expect(stale).toContain("Sin estado de git nuevo; los contadores pueden estar desfasados");
    // Stale data is a warning beside what is still true, not an error in its place.
    expect(stale).toMatch(/<p role="alert" class="[^"]*bg-warn\/10[^"]*">Sin estado de git nuevo/);
  });

  test("a failed refresh of the terminals keeps the list and says it may be stale", async () => {
    const html = await renderWith(
      <ProjectsTree />,
      [
        [["projects"], projects()],
        [[...gitSummaryQuery.queryKey], { items: {} }],
      ],
      failQuery(["terminals"], { terminals: [], locations: [] }, "pty host busy"),
    );
    expect(html).not.toContain("No se pueden listar las terminales");
    expect(html).toContain("La lista de terminales puede estar desfasada: pty host busy");
  });
});

describe("UpdateLines", () => {
  const lines = (items?: Parameters<typeof UpdateLines>[0]["items"], error: Error | null = null) =>
    renderToStaticMarkup(<UpdateLines items={items} error={error} />);
  const line = {
    location: "repo:a",
    label: "a",
    reason: null,
    detail: null,
    commits: 0,
    submodules: null,
  };

  test("one line per repo, saying what happened and why it was left alone", () => {
    const html = lines([
      { ...line, result: "updated", commits: 2 },
      { ...line, location: "repo:b", label: "b", result: "up_to_date" },
      {
        ...line,
        location: "repo:c",
        label: "c",
        result: "skipped",
        reason: "dirty",
        detail: "Hay 1 fichero cambiado sin commitear.",
      },
      { ...line, location: "repo:d", label: "d", result: "failed", detail: "git exited with 128" },
    ]);
    expect(html).toContain('aria-label="Resultado de actualizar repos"');
    expect(html).toContain("avanzado 2 commits");
    expect(html).toContain("al día");
    expect(html).toContain("sin tocar: Hay 1 fichero cambiado sin commitear.");
    expect(html).toMatch(/class="text-bad"><span[^>]*>d<\/span> error: git exited with 128/);
  });

  test("nothing before the first run; a failed request is an alert", () => {
    expect(lines(undefined)).toBe("");
    const html = lines(undefined, new Error("boom"));
    expect(html).toContain('role="alert"');
    expect(html).toContain("No se han podido actualizar los repos: boom");
  });

  test("what the submodules did follows the repo's line; their failure turns it red", () => {
    const html = lines([
      {
        ...line,
        result: "updated",
        commits: 7,
        submodules: {
          moved: ["contract"],
          kept: [{ path: "landing", why: "tiene cambios sin commitear" }],
          error: null,
        },
      },
      {
        ...line,
        location: "repo:b",
        label: "b",
        result: "up_to_date",
        submodules: { moved: [], kept: [], error: "git exited with 1: boom" },
      },
    ]);
    expect(html).toContain(
      "avanzado 7 commits · submódulos al día: contract · landing sin mover: tiene cambios sin commitear",
    );
    expect(html).toMatch(
      /class="text-bad"><span[^>]*>b<\/span> al día · los submódulos no se han actualizado: git exited with 1: boom/,
    );
  });
});

describe("envState", () => {
  const r = (...servers: (string | null)[]) => servers.map((s) => ({ servers: s }));

  test("reads the provider's per-repo servers", () => {
    expect(envState(r("backend,celery", "frontend"))).toBe("up");
    expect(envState(r("stopped", "stopped", null))).toBe("down");
    expect(envState(r("backend", "stopped"))).toBe("partial");
    expect(envState(r(null, null))).toBe("unknown");
    expect(envState([])).toBe("unknown");
  });

  test("a running command that changes the servers wins; logs and ended ones do not", () => {
    const t = (action: "start" | "logs", state: TerminalInfo["state"] = "running") =>
      terminal({ harness: "env", env: "e", action, state });
    expect(envState(r("stopped"), [t("start")])).toBe("busy");
    expect(envState(r("stopped"), [t("logs")])).toBe("down");
    expect(envState(r("stopped"), [t("start", "exited")])).toBe("down");
  });
});
