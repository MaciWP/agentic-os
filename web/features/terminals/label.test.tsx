import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessChip } from "./harness.tsx";
import { kindLabel, terminalLabel } from "./queries.ts";
import { terminal } from "./test-fixtures.ts";

describe("terminal label", () => {
  test("a name wins everywhere the terminal is named; without one, its kind", () => {
    expect(terminalLabel(terminal({ harness: "shell" }))).toBe("Shell");
    expect(terminalLabel(terminal({ harness: "shell", name: "Pruebas API" }))).toBe("Pruebas API");
    expect(kindLabel(terminal({ harness: "shell", name: "Pruebas API" }))).toBe("Shell");
  });

  test("a Claude on the PC's model says so; an old host's record without a model does not", () => {
    expect(kindLabel(terminal({ harness: "claude", model: "local" }))).toBe("Claude local");
    expect(kindLabel(terminal({ harness: "claude", model: "opus" }))).toBe("Claude");
    expect(kindLabel(terminal({ harness: "claude" }))).toBe("Claude");
  });

  test("the chip shows the name and keeps the kind in its title", () => {
    const named = renderToStaticMarkup(
      <HarnessChip t={terminal({ harness: "codex", name: "Revisión" })} />,
    );
    expect(named).toContain(">Revisión<");
    expect(named).toContain('title="Revisión · Codex"');
    const bare = renderToStaticMarkup(<HarnessChip t={terminal({ harness: "codex" })} />);
    expect(bare).toContain(">Codex<");
    expect(bare).toContain('title="Codex"');
  });
});
