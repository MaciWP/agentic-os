import { describe, expect, test } from "bun:test";
import { adfToMarkdown, extractAcceptanceCriteria } from "./adf.ts";

const text = (t: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});
const task = (...content: unknown[]) => ({ type: "taskItem", attrs: { state: "TODO" }, content });

// Mirrors the shape of real tickets: H3 sections, several task lists, mentions and status lozenges.
const doc = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 3 }, content: [text("🧩 Historia de Usuario")] },
    { type: "paragraph", content: [text("Como", [{ type: "strong" }]), text(" admin")] },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [text("🎯 Criterios de Aceptación (DoD funcional)")],
    },
    { type: "taskList", content: [task(text("First criterion")), task(text("Second"))] },
    {
      type: "taskList",
      content: [
        task({ type: "mention", attrs: { text: "@Someone" } }, text(" evaluates X")),
        task({ type: "status", attrs: { text: "¿NECESARIO?" } }, text(" recover → sí")),
      ],
    },
    { type: "paragraph", content: [text("Trailing note")] },
    { type: "heading", attrs: { level: 3 }, content: [text("Notas")] },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [text("not an AC")] }] },
      ],
    },
  ],
};

describe("adfToMarkdown", () => {
  test("renders headings, marks, task lists, mentions and status", () => {
    const md = adfToMarkdown(doc);
    expect(md).toContain("### 🎯 Criterios de Aceptación (DoD funcional)");
    expect(md).toContain("**Como** admin");
    expect(md).toContain("- [ ] @Someone evaluates X");
    expect(md).toContain("- [ ] [¿NECESARIO?] recover → sí");
  });

  test("closes a code fence longer than any backtick run inside it", () => {
    const md = adfToMarkdown({
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "md" }, content: [text("a ``` b")] }],
    });
    expect(md).toBe("````md\na ``` b\n````");
  });

  test("renders links, ordered lists and tables", () => {
    const md = adfToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [text("PR", [{ type: "link", attrs: { href: "https://x.test/1" } }])],
        },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("one")] }] }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [text("a|b")] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [text("1")] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(md).toBe("[PR](https://x.test/1)\n\n1. one\n\n| a\\|b |\n| --- |\n| 1 |");
  });

  test("returns an empty string for a missing description", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
  });
});

describe("extractAcceptanceCriteria", () => {
  test("collects every item under the AC heading until the next heading", () => {
    expect(extractAcceptanceCriteria(adfToMarkdown(doc))).toEqual([
      "First criterion",
      "Second",
      "@Someone evaluates X",
      "[¿NECESARIO?] recover → sí",
    ]);
  });

  test("returns nothing when the ticket has no AC section", () => {
    expect(extractAcceptanceCriteria("### Contexto\n\n- just a list")).toEqual([]);
  });
});
