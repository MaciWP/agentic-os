import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftShelf, publishDrafts } from "./draft-strip.tsx";

const render = (el: ReactElement) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);

describe("draft shelf", () => {
  afterEach(() => {
    publishDrafts("t 1", []);
    publishDrafts("t2", []);
  });

  test("each terminal's draft images show from its route, numbered and with their size", () => {
    publishDrafts("t 1", [
      { n: 1, v: 4, size: 2048 },
      { n: 3, v: 7, size: 3 * 1024 * 1024 },
    ]);
    const html = render(<DraftShelf />);
    expect(html).toContain('aria-label="Imágenes del borrador"');
    expect(html).toContain('src="/api/terminals/t%201/drafts/1?v=4"');
    expect(html).toContain('src="/api/terminals/t%201/drafts/3?v=7"');
    expect(html).toContain('class="tile-num');
    expect(html).toContain(">#3</b>");
    expect(html).toContain(">2 KB</span>");
    expect(html).toContain(">3.0 MB</span>");
  });

  test("folded, only the thumbnail and its number; a cleared draft leaves nothing", () => {
    publishDrafts("t2", [{ n: 2, v: 1, size: 10 }]);
    const html = render(<DraftShelf vertical />);
    expect(html).toContain('aria-label="Ver la imagen 2 en grande"');
    expect(html).not.toContain(" KB</span>");
    publishDrafts("t2", []);
    expect(render(<DraftShelf />)).toBe("");
  });
});
