import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitCounts } from "./panel.tsx";

describe("GitCounts", () => {
  const counts = (s: Parameters<typeof GitCounts>[0]["s"]) =>
    renderToStaticMarkup(<GitCounts s={s} />);

  test("clean and in step with the upstream shows nothing", () => {
    expect(counts({ branch: "main", ahead: 0, behind: 0, changed: 0, truncated: false })).toBe("");
    expect(counts(undefined)).toBe("");
  });

  test("commits to push and pull and the changed files, spelled out for screen readers", () => {
    const html = counts({ branch: "main", ahead: 1, behind: 2, changed: 4, truncated: false });
    expect(html).toContain("↑1 ↓2 · 4 cambios");
    expect(html).toContain("1 commit por delante, 2 commits por detrás, 4 ficheros cambiados");
    const capped = counts({
      branch: "x",
      ahead: null,
      behind: null,
      changed: 2000,
      truncated: true,
    });
    expect(capped).toContain("2000+ cambios");
  });
});
