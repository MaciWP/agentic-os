import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { PaletteButton, sourceNotes } from "./palette.tsx";

const read = <T,>(over: { isPending?: boolean; isError?: boolean; data?: T }) => ({
  isPending: false,
  isError: false,
  ...over,
});

describe("sourceNotes", () => {
  test("says why a list may be short: loading, failed, off, or GitHub's own errors", () => {
    const tickets = read({ data: { tickets: [] } });
    const own = { terminals: read({ data: {} }), projects: read({ data: {} }) };
    expect(sourceNotes(tickets, read({ data: { prs: [], errors: [] } }), own)).toEqual([]);
    expect(sourceNotes(read({ isPending: true }), read({ isError: true }), own)).toEqual([
      "Cargando tickets…",
      "GitHub no responde: sin PR.",
    ]);
    // An unread terminal or project list is no reason to say nothing matches either.
    expect(
      sourceNotes(tickets, read({ data: { prs: [], errors: [] } }), {
        terminals: read({ isPending: true }),
        projects: read({ isError: true }),
      }),
    ).toEqual(["Cargando terminales…", "No se leyeron los proyectos: no salen."]);
    // GitHub answers 200 with the logins it could not read: no PR is not "nothing matches".
    expect(
      sourceNotes(tickets, read({ data: { prs: [], errors: ["gh: bad credentials"] } }), own),
    ).toEqual(["GitHub incompleto: gh: bad credentials"]);
    expect(
      sourceNotes(read({ data: { disabled: true } }), read({ data: { prs: [], errors: [] } }), own),
    ).toEqual(["Jira sin conectar: sin tickets."]);
  });
});

describe("PaletteButton", () => {
  const as = async (userAgent: string) => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true });
    try {
      return await renderWith(<PaletteButton />);
    } finally {
      if (real) Object.defineProperty(globalThis, "navigator", real);
    }
  };

  test("names the shortcut with the key this keyboard has", async () => {
    expect(await as("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toContain("Buscar (⌘K)");
    // On Windows ⌘ is no key at all.
    const windows = await as("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(windows).toContain("Buscar (Ctrl+K)");
    expect(windows).not.toContain("⌘");
  });
});
