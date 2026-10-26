import { describe, expect, test } from "bun:test";
import {
  barOf,
  fillPrompt,
  promptRefusal,
  variablesIn,
  withBar,
  withBody,
  withField,
} from "./work-bar.ts";

describe("barOf and withBar", () => {
  test("reads bar, label and order; a bad field is left out, not fatal", () => {
    expect(barOf("---\nname: Tests\nbar: true\nlabel: Tests\norder: 2\n---\nRun them")).toEqual({
      bar: true,
      label: "Tests",
      order: 2,
    });
    expect(barOf("---\nbar: maybe\norder: soon\n---\nx")).toEqual({ bar: false });
    expect(barOf("No frontmatter")).toEqual({ bar: false });
  });

  test("sets bar in place, keeps the other fields and the body, and adds a block when none", () => {
    const doc = "---\nname: Tests\nbar: false\nmetadata:\n  a: 1\n---\nRun them\n";
    const on = withBar(doc, true);
    expect(on).toBe("---\nname: Tests\nmetadata:\n  a: 1\nbar: true\n---\nRun them\n");
    expect(barOf(on).bar).toBe(true);
    expect(barOf(withBar(on, false)).bar).toBe(false);
    expect(withBar("Run them", true)).toBe("---\nbar: true\n---\nRun them");
  });
});

describe("fillPrompt", () => {
  test("fills every known variable and leaves other braces as the prompt's text", () => {
    expect(
      fillPrompt("Review {{ticket}} on {{branch}} in {{cwd}}; keep {{other}}", {
        ticket: "ABC-1",
        branch: "feature/ABC-1",
        cwd: "/r/abc",
      }),
    ).toEqual({ text: "Review ABC-1 on feature/ABC-1 in /r/abc; keep {{other}}" });
  });

  test("names each missing variable once instead of sending a hole", () => {
    expect(fillPrompt("{{ticket}} {{ticket}} {{objective}}", { ticket: null })).toEqual({
      missing: ["ticket", "objective"],
    });
  });

  test("a value is one line without control characters", () => {
    expect(fillPrompt("Goal: {{objective}}.", { objective: "Fix\nthe \u001b[2Jhost" })).toEqual({
      text: "Goal: Fix the [2Jhost.",
    });
  });

  test("variablesIn lists the known names in order of first use", () => {
    expect(variablesIn("{{cwd}} {{x}} {{location}} {{cwd}}")).toEqual(["cwd", "location"]);
  });
});

describe("promptRefusal", () => {
  const agent = (state: "working" | "needs_you" | null, asks?: "permission") => ({ state, asks });
  test("only Claude or Codex waiting for its next message takes a bar prompt", () => {
    expect(promptRefusal({ harness: "claude", agent: agent("needs_you") })).toBeNull();
    expect(promptRefusal({ harness: "codex", agent: agent("needs_you") })).toBeNull();
    expect(promptRefusal({ harness: "claude", agent: agent("working") })).toBe("agent_busy");
    expect(promptRefusal({ harness: "claude", agent: agent("needs_you", "permission") })).toBe(
      "agent_asks",
    );
    expect(promptRefusal({ harness: "claude", agent: null })).toBe("no_state");
    expect(promptRefusal({ harness: "grok", agent: agent(null) })).toBe("no_state");
    expect(promptRefusal({ harness: "shell" })).toBe("not_an_agent");
    expect(promptRefusal({ harness: "env" })).toBe("not_an_agent");
  });
});

describe("withField and withBody", () => {
  const doc = "---\nname: Repaso\nlabel: Repaso\nbar: true\n---\nHaz otro repaso";
  test("sets, replaces and removes one field, keeping the others and the body", () => {
    const set = withField(doc, "label", "Otro\nrepaso");
    expect(set).toBe("---\nname: Repaso\nbar: true\nlabel: Otro repaso\n---\nHaz otro repaso");
    expect(barOf(set)).toMatchObject({ bar: true, label: "Otro repaso" });
    expect(withField(doc, "label", " ")).toBe("---\nname: Repaso\nbar: true\n---\nHaz otro repaso");
    expect(withField("Body", "description", "")).toBe("Body");
  });
  test("replaces the body under the same frontmatter", () => {
    expect(withBody(doc, "Nuevo")).toBe("---\nname: Repaso\nlabel: Repaso\nbar: true\n---\nNuevo");
    expect(withBody("Viejo", "Nuevo")).toBe("Nuevo");
  });
});
