import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CrashBoundary } from "../../crash.tsx";
import { failQuery, renderWith } from "../../test-render.tsx";
import { projects } from "../projects/test-fixtures.ts";
import { GridPage } from "./grid.tsx";
import { type GridSearch, gitTile, jobTile } from "./grid-state.ts";
import { RAIL_MIN, railWidth } from "./mesa-rail.tsx";
import type { TerminalInfo } from "./queries.ts";
import { terminal } from "./test-fixtures.ts";
import { tileBoundary } from "./tile.tsx";

const render = (search: GridSearch, terminals: TerminalInfo[] = []) =>
  renderWith(<GridPage search={search} />, [
    [["projects"], projects()],
    [
      ["terminals"],
      {
        terminals,
        locations: [
          { id: "app", label: "Agentic OS", cwd: "/work/app" },
          { id: "repo:alpha", label: "alpha", cwd: "/src/alpha" },
        ],
      },
    ],
  ]);

const six = ["a", "b", "c", "d", "e", "f"].map((id) =>
  terminal({ id, location: "repo:alpha", cwd: "/src/alpha" }),
);

describe("railWidth", () => {
  test("a rail keeps its floor, and never takes more than 45% of the window", () => {
    expect(railWidth(100, 1440)).toBe(RAIL_MIN);
    expect(railWidth(380.4, 1440)).toBe(380);
    // No fixed cap: a wide screen gives the rail what is asked, up to its 45 %.
    expect(railWidth(900, 2960)).toBe(900);
    expect(railWidth(900, 1440)).toBe(648);
    expect(railWidth(560, 1000)).toBe(450);
    // On a window too narrow for both, the floor wins: the rail stays usable.
    expect(railWidth(300, 400)).toBe(RAIL_MIN);
  });
});

describe("tile crash", () => {
  // String renders cannot throw into a boundary (crash.test.tsx covers the catch); this pins
  // that every tile view sits inside its own boundary, named after what the tile shows.
  test("each tile view has its own boundary that shows only that tile's Crash", () => {
    for (const [view, what] of [
      ["terminal", "La terminal"],
      ["git", "Git"],
      ["job", "La salida"],
    ] as const) {
      const element = tileBoundary(view, <i>body</i>);
      expect(element.type).toBe(CrashBoundary);
      const boundary = new CrashBoundary(element.props);
      expect(renderToStaticMarkup(boundary.render())).toBe("<i>body</i>");
      boundary.state = CrashBoundary.getDerivedStateFromError(new Error("boom"));
      expect(renderToStaticMarkup(boundary.render())).toContain(`${what} ha fallado`);
    }
  });
});

describe("GridPage", () => {
  test("an empty grid opens the rail on the Mesas and says what to do", async () => {
    const html = await render({ ids: "" }, [terminal({ id: "a", location: "repo:alpha" })]);
    expect(html).toContain('aria-label="Mesas y proyectos"');
    // Its inner edge sets its width; with none kept, the default for the screen.
    expect(html).toMatch(/role="separator"[^>]*aria-controls="grid-picker"/);
    expect(html).toMatch(/aria-label="Mesas y proyectos" class="[^"]*w-\[340px\]/);
    // The Mesas on top, at their own height; under them the sources, the projects tree first.
    expect(html).toMatch(/<h2[^>]*>Mesas<span[^>]*>1<\/span><\/h2>/);
    expect(html).toContain("grid-cols-1 grid-rows-[fit-content(70%)_minmax(160px,1fr)]");
    const sources = html.slice(html.indexOf('aria-label="Fuentes del carril"'));
    expect(sources).toMatch(/aria-pressed="true"[^>]*>Proyectos<\/button>/);
    expect(sources).toMatch(/aria-pressed="false"[^>]*>Tickets/);
    expect(sources).toMatch(/aria-pressed="false"[^>]*>PRs/);
    expect(html.indexOf('aria-label="Fuera de las Mesas"')).toBeLessThan(
      html.indexOf('aria-label="Fuentes del carril"'),
    );
    // Each Mesa is a card in its state's group; nothing waits yet.
    expect(html).toContain("Nadie te espera.");
    expect(html).toContain("«+ Claude»");
    // A running terminal in no Mesa stays reachable from the list.
    expect(html).toContain('aria-label="Fuera de las Mesas"');
    expect(html).toContain('data-loose="a"');
    expect(html).not.toMatch(/aria-label="Cerrar [^"]*" title="Cerrar la terminal/);
    // What to do with a Mesa is in its card's menu, out of the tab order: the right click, F2
    // and Supr on the card do the same.
    expect(html).toMatch(/tabindex="-1"[^>]*aria-label="Opciones de Mesa 1"/);
    // The bar says only the page and what last happened: no count, no layout, no focus mode.
    expect(html).not.toContain("en la cuadrícula");
    expect(html).not.toContain("Enfoque");
  });

  test("an ended terminal in no Mesa waits under «Fuera de las Mesas» to be closed", async () => {
    const html = await render({ ids: "" }, [
      terminal({ id: "a", location: "repo:alpha" }),
      terminal({ id: "z", location: "repo:alpha", state: "exited" }),
      terminal({ id: "y", location: "repo:alpha", state: "lost" }),
    ]);
    const loose = html.slice(html.indexOf('aria-label="Fuera de las Mesas"'));
    expect(loose).toContain('data-loose="z"');
    expect(loose).toContain('data-loose="y"');
    expect(loose.match(/title="Cerrar la terminal: ya no está en marcha"/g)).toHaveLength(2);
    expect(loose).toContain("Cerrar terminadas (2)");
  });

  test("a grid with tiles keeps the rail open with the layouts in its header, and no right rail", async () => {
    const html = await render({ ids: "a,b,c,d,e,f" }, six);
    expect(html.match(/<section aria-label="Claude en src\/alpha"/g)).toHaveLength(6);
    expect(html).toMatch(
      /aria-expanded="true" aria-controls="grid-picker" aria-label="Ocultar el carril"/,
    );
    expect(html).not.toContain("grid-bring");
    expect(html).not.toContain("Mostrar tickets y PR");
    // The layouts sit in the rail's header, not in the bar.
    const rail = html.slice(html.indexOf('id="grid-picker"'), html.indexOf("data-new-mesa"));
    for (const label of ["Columnas", "Cuadrícula", "Principal"])
      expect(rail).toContain(`aria-label="Distribución: ${label}"`);
  });

  test("a git tile sits among the terminals, numbered, by its checkout's name", async () => {
    const html = await render({ ids: `a,${gitTile("repo:alpha")}` }, six);
    expect(html).toContain('<section aria-label="Claude en src/alpha"');
    expect(html).toMatch(
      /<section aria-label="Git de alpha\/main" data-harness="git" data-git-tile="repo:alpha"/,
    );
    // Its header loads with the git view, as a terminal's loads with xterm.
    expect(html.match(/aria-label="Cargando"/g)).toHaveLength(2);
  });

  test("an env's output is a tile too: numbered, named by the env, no window of its own", async () => {
    const html = await render({ ids: `a,${jobTile("env-a")}` }, six);
    const tile = html.slice(html.indexOf('<section aria-label="Salida de env-a"'));
    expect(tile).toMatch(
      /^<section aria-label="Salida de env-a" data-harness="env" data-job-tile="env-a"/,
    );
    expect(tile).not.toContain("data-terminal-id");
    expect(tile).toContain('aria-label="Mover la salida 2"');
    expect(tile).toContain('aria-label="Quitar Salida de env-a de la cuadrícula"');
    expect(tile.slice(0, tile.indexOf("</section>"))).not.toContain("Ventana aparte");
  });

  test("a maximized tile is the only one mounted", async () => {
    const html = await render({ ids: "a,b,c", max: "b" }, six);
    expect(html.match(/<section aria-label="Claude en src\/alpha"/g)).toHaveLength(1);
    // A tile alone has no layout to choose.
    expect(html).not.toContain('aria-label="Distribución"');
  });

  test("the bar opens Claude in the free folder; the rail has no tabs to choose", async () => {
    const html = await render({ ids: "" }, six);
    expect(html).toContain(">Mesa</h1>");
    expect(html).toMatch(/title="[^"]*carpeta libre[^"]*"[^>]*>.*?Claude<\/button>/s);
    expect(html).not.toContain("Qué mostrar en el carril");
    const rail = html.slice(html.indexOf('id="grid-picker"'));
    expect(rail).not.toMatch(/>Terminales<\/button>/);
  });

  test("the page bar switches the view; Terminales is the one shown", async () => {
    const html = await render({ ids: "" }, six);
    const views = html.slice(html.indexOf('aria-label="Vista de la Mesa"'));
    expect(views).toMatch(/aria-pressed="true"[^>]*>Terminales<\/button>/);
    expect(views).toMatch(/aria-pressed="false"[^>]*>Mosaico<\/button>/);
    expect(views).toMatch(/aria-pressed="false"[^>]*>Lienzo<\/button>/);
    // Nothing to return to before a Mesa is opened from an overview.
    expect(html).not.toContain("Volver al");
  });

  test("?view= shows every Mesa instead of the open one's tiles", async () => {
    const mosaic = await render({ ids: "a,b", view: "mosaico" }, six);
    // A link that names tiles opens Terminales, whatever view it carries.
    expect(mosaic).toContain('<section aria-label="Claude en src/alpha"');
    const cells = await render({ view: "mosaico" }, six);
    expect(cells).toMatch(/aria-pressed="true"[^>]*>Mosaico<\/button>/);
    expect(cells).toContain("data-mesa-cell=");
    expect(cells).not.toContain('<section aria-label="Claude en src/alpha"');
    const canvas = await render({ view: "lienzo" }, six);
    expect(canvas).toContain('aria-label="Lienzo de las Mesas"');
    expect(canvas).toContain('aria-label="Acercar"');
  });

  test("a failed terminals read is an error in both overviews, never an empty one", async () => {
    for (const [view, label] of [
      ["mosaico", "Mosaico"],
      ["lienzo", "Lienzo"],
    ] as const) {
      const html = await renderWith(
        <GridPage search={{ view }} />,
        [[["projects"], projects()]],
        failQuery(["terminals"]),
      );
      expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${label}</button>`));
      expect(html).toContain("No se han podido leer las terminales");
      expect(html).not.toContain("data-mesa-cell=");
      expect(html).not.toContain('aria-label="Lienzo de las Mesas"');
    }
  });

  test("a node link opens no drawer: the rail shows the projects tree, with the node marked", async () => {
    const html = await render({ ids: "a,b", node: "repo:alpha" }, six);
    expect(html).not.toContain('aria-label="Proyecto alpha"');
    expect(html.match(/<section aria-label="Claude en src\/alpha"/g)).toHaveLength(2);
    expect(html).not.toContain("hidden md:grid");
    expect(html).toMatch(/<div data-node="repo:alpha" data-marked="true" aria-current="true"/);
  });

  test("an unknown maximized id is ignored", async () => {
    const html = await render({ ids: "a,b", max: "z" }, six);
    expect(html.match(/<section aria-label="Claude en src\/alpha"/g)).toHaveLength(2);
  });

  test("a known terminal outside a full grid shows alone", async () => {
    const html = await render({ ids: "a,b,c,d,e", max: "f" }, six);
    expect(html.match(/<section aria-label="Claude en src\/alpha"/g)).toHaveLength(1);
  });

  // Rule 3: terminals not read yet are not "no terminals".
  test("while terminals are unread the maximized tile stays and tabs say their state is unknown", async () => {
    const html = await renderWith(<GridPage search={{ ids: "a,b", max: "f" }} />, [
      [["projects"], projects()],
    ]);
    expect(html).toContain('data-terminal-id="f"');
    expect(html).not.toContain('data-terminal-id="a"');
    expect(html).toContain("Leyendo el estado de las terminales");
  });

  test("a failed terminals read marks the tabs' state as unavailable", async () => {
    const html = await renderWith(
      <GridPage search={{ ids: "a" }} />,
      [[["projects"], projects()]],
      failQuery(["terminals"]),
    );
    expect(html).toContain("No se ha podido leer el estado de las terminales");
  });
});
