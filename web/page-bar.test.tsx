import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { PageBar } from "./page-bar.tsx";

describe("PageBar", () => {
  test("outside the Shell there is no slot, so the bar shows in place as its own row", () => {
    const html = renderToString(
      <PageBar>
        <h1>Mesa</h1>
      </PageBar>,
    );
    expect(html).toContain("<h1>Mesa</h1>");
    expect(html).toContain("border-b");
  });
});
