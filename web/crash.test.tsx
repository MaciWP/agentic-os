import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { router } from "./app.tsx";
import { CrashBoundary, RouteCrash } from "./crash.tsx";

// React catches render errors only in a client render, which these string-render tests do not
// have; so each part is checked on its own: the router uses RouteCrash, a boundary that caught
// shows the Crash instead of its children, and the Crash says what failed.
describe("crash handling", () => {
  test("the router replaces a page that throws with RouteCrash", () => {
    expect(router.options.defaultErrorComponent).toBe(RouteCrash);
    const html = renderToStaticMarkup(<RouteCrash error={new Error("boom")} reset={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Esta página ha fallado");
    expect(html).toContain("boom");
    expect(html).toContain("Reintentar");
  });

  test("a boundary shows its children until one throws, then only the Crash", () => {
    const boundary = new CrashBoundary({ what: "La terminal", children: <i>tile</i> });
    expect(renderToStaticMarkup(boundary.render())).toBe("<i>tile</i>");
    boundary.state = CrashBoundary.getDerivedStateFromError(new Error("xterm died"));
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain("La terminal ha fallado");
    expect(html).toContain("xterm died");
    expect(html).not.toContain("<i>tile</i>");
  });

  test("a thrown non-Error still shows a Crash", () => {
    const boundary = new CrashBoundary({ what: "El panel", children: null });
    boundary.state = CrashBoundary.getDerivedStateFromError(undefined);
    expect(renderToStaticMarkup(boundary.render())).toContain("error desconocido");
  });
});
