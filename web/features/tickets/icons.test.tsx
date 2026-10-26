import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JiraStatus } from "./icons.tsx";

describe("JiraStatus", () => {
  test("Jira's name as given, cut only with the full name in its title", () => {
    const html = renderToStaticMarkup(
      <JiraStatus status={{ name: "In Product Review", category: "indeterminate" }} />,
    );
    expect(html).toContain('title="In Product Review"');
    expect(html).toContain('<span class="truncate">In Product Review</span>');
    expect(html).toContain("<svg");
  });
});
