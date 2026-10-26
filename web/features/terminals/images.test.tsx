import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { ImageGrid } from "./image-grid.tsx";
import { markAll, stepFocus, toggleMark } from "./image-marks.ts";
import { CLOSED } from "./images.tsx";

type Source = "pasted" | "captured" | "folder";
const item = (id: string, mtime = Date.now() - 60_000) => {
  const [source, name] = id.split(":") as [Source, string];
  return { id, source, name, mtime, bytes: 12 };
};
const ok = (source: Source, dir: string) => ({
  source,
  state: "ok" as const,
  dir,
  detail: null,
});
const grid = (data: unknown, picker = { ...CLOSED, open: true }, blocked: string | null = null) =>
  renderWith(
    <ImageGrid
      id="t1"
      blocked={blocked}
      picker={picker}
      grid={{ current: null }}
      close={() => {}}
    />,
    data === undefined
      ? []
      : [
          [["images"], data],
          [["access"], { remote: false, desktop: true }],
        ],
  );

describe("marks", () => {
  test("a click marks or unmarks; past the cap it says no", () => {
    expect(toggleMark([], "a")).toEqual(["a"]);
    expect(toggleMark(["a", "b"], "a")).toEqual(["b"]);
    const five = ["a", "b", "c", "d", "e"];
    expect(toggleMark(five, "f")).toBeNull();
    expect(toggleMark(five, "c")).toEqual(["a", "b", "d", "e"]);
  });

  test("images just kept go first, once and in order; the oldest marks drop past the cap", () => {
    expect(markAll(["a", "b"], ["p"])).toEqual(["p", "a", "b"]);
    expect(markAll(["a", "p"], ["p"])).toEqual(["p", "a"]);
    expect(markAll(["a", "b", "c", "d", "e"], ["p"])).toEqual(["p", "a", "b", "c", "d"]);
    expect(markAll(["a", "q", "b"], ["p", "q"])).toEqual(["p", "q", "a", "b"]);
    expect(markAll(["a"], [])).toEqual(["a"]);
  });

  test("arrows move inside the grid of four; anything else is not theirs", () => {
    expect(stepFocus(-1, "ArrowRight", 9)).toBe(0);
    expect(stepFocus(0, "ArrowRight", 9)).toBe(1);
    expect(stepFocus(1, "ArrowDown", 9)).toBe(5);
    expect(stepFocus(6, "ArrowDown", 9)).toBe(8);
    expect(stepFocus(2, "ArrowUp", 9)).toBe(0);
    expect(stepFocus(0, "ArrowLeft", 9)).toBe(0);
    expect(stepFocus(0, "Enter", 9)).toBeNull();
    expect(stepFocus(-1, "ArrowRight", 0)).toBeNull();
  });
});

describe("ImageGrid", () => {
  test("loading shows placeholders, not an empty history", async () => {
    const html = await grid(undefined);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Aún no hay imágenes");
  });

  test("thumbnails come from the server by id, with their source and a draggable button", async () => {
    const shot = "folder:Captura 10.00.00 p. m. #2.png";
    const html = await grid({
      items: [item(shot), item("pasted:00000000-0000-4000-8000-000000000000.png")],
      sources: [ok("pasted", "/d/pastes"), ok("folder", "/Users/me/Desktop")],
    });
    expect(html).toContain(`src="/api/images/${encodeURIComponent(shot)}"`);
    expect(html).toContain('loading="lazy"');
    expect(html.match(/data-thumb=/g)).toHaveLength(2);
    expect(html).not.toMatch(/data-thumb="[^"]*"[^>]*aria-pressed="true"/);
    // Both sources: the filter shows, on "Todas".
    expect(html).toMatch(/aria-pressed="true"[^>]*>Todas</);
    expect(html).toContain("Carpeta · hace 1 min");
    expect(html).toContain("Pegar (0)");
    expect(html).not.toContain("Carpeta de capturas");
    // A capture is always at hand, also for a terminal that takes no input yet.
    expect(html).toMatch(/<button[^>]*>Capturar<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Capturar/);
  });

  test("a folder it cannot read says so beside the pasted images, which stay", async () => {
    const html = await grid({
      items: [item("pasted:00000000-0000-4000-8000-000000000000.png")],
      sources: [
        ok("pasted", "/d/pastes"),
        { source: "folder", state: "denied", dir: "/Users/me/Documents", detail: "EPERM" },
      ],
    });
    expect(html).toContain("Carpeta de capturas");
    expect(html).toContain("/Users/me/Documents");
    expect(html).toContain("el sistema no deja leerla");
    expect(html).toContain("aria-pressed");
  });

  test("the clipboard watcher says when it watches and when it stopped", async () => {
    const sources = [ok("pasted", "/p")];
    const off = await grid({ items: [], sources, clipboard: { state: "off", detail: null } });
    expect(off).not.toContain("cada imagen que copies");
    expect(off).not.toContain("vigilante");
    const on = await grid({ items: [], sources, clipboard: { state: "watching", detail: null } });
    expect(on).toContain("Se guarda cada imagen que copies.");
    const failed = await grid({
      items: [],
      sources,
      clipboard: { state: "failed", detail: "ended (1): execution error" },
    });
    expect(failed).toContain(
      "El vigilante del portapapeles se ha parado: ended (1): execution error.",
    );
  });

  test("captures have their own filter, and say so on their thumbnail", async () => {
    const html = await grid({
      items: [item("captured:00000000-0000-4000-8000-000000000000.png")],
      sources: [ok("pasted", "/p"), ok("captured", "/p/captures"), ok("folder", "/f")],
    });
    expect(html).toMatch(/aria-pressed="false"[^>]*>Capturas</);
    expect(html).toContain("Capturada · hace 1 min");
  });

  test("on the Mac, ⌃⌘4's trouble is said, with the grant when it lacks the permission", async () => {
    const sources = [ok("pasted", "/p")];
    const shown = (state: string, detail: string | null = null) =>
      grid({ items: [], sources, hotkey: { state, detail } });
    for (const state of ["off", "starting", "ready", "capturing"])
      expect(await shown(state)).not.toContain('role="status" class="text-[11px] text-warn"');
    const denied = await shown("denied");
    expect(denied).toContain("necesita el permiso de Grabación de pantalla");
    expect(denied).toMatch(/<button[^>]*>Conceder permiso<\/button>/);
    expect(await shown("taken")).toContain("macOS no deja usar ⌃⌘4: otra app tiene esas teclas.");
    expect(await shown("not_installed")).toContain("bun run mac:build AgenticCapture");
    expect(await shown("failed", "the helper ended")).toContain(
      "El atajo ⌃⌘4 se ha parado: the helper ended.",
    );
  });

  test("an empty history explains how to fill it; an upload in progress is not empty", async () => {
    const empty = { items: [], sources: [ok("pasted", "/p"), ok("folder", "/f")] };
    expect(await grid(empty)).toMatch(
      /Aún no hay imágenes\. .*captura una zona con (⌃⌘4|Ctrl\+Shift\+4)/,
    );
    const uploading = await grid(empty, { open: true, marks: null, uploading: true });
    expect(uploading).toContain("Guardando…");
    expect(uploading).not.toContain("Aún no hay imágenes");
  });

  test("a terminal that takes no input says why, and Pegar stays off", async () => {
    const html = await grid(
      { items: [item("folder:a.png")], sources: [ok("folder", "/f")] },
      undefined,
      "la terminal no está en marcha",
    );
    expect(html).toContain("Esta terminal no recibe imágenes: la terminal no está en marcha.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Pegar \(0\)/);
  });

  test("the app's history only drags: no Pegar, and a failed Cmd+V says why", async () => {
    const html = await renderWith(
      <ImageGrid
        id={null}
        blocked={null}
        picker={{ ...CLOSED, open: true }}
        grid={{ current: null }}
        notice="No se ha guardado la imagen: la imagen pasa de 10 MB."
        close={() => {}}
      />,
      [
        [["images"], { items: [item("folder:a.png")], sources: [ok("folder", "/f")] }],
        [["access"], { remote: false, desktop: true }],
      ],
    );
    expect(html).not.toContain("Pegar (");
    expect(html).toContain("Arrastra una miniatura a cualquier terminal.");
    expect(html).toMatch(/<button[^>]*>Capturar<\/button>/);
    expect(html).toContain("No se ha guardado la imagen: la imagen pasa de 10 MB.");
  });

  test("a remote device shoots its own screen, and says so where the browser cannot", async () => {
    const remote = async (getDisplayMedia?: () => void) => {
      const saved = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: getDisplayMedia ? { getDisplayMedia } : undefined,
      });
      try {
        return await renderWith(
          <ImageGrid
            id="t1"
            blocked={null}
            picker={{ ...CLOSED, open: true }}
            grid={{ current: null }}
            close={() => {}}
          />,
          [
            [
              ["images"],
              {
                items: [],
                sources: [ok("pasted", "/p")],
                hotkey: { state: "denied", detail: null },
              },
            ],
            [["access"], { remote: true, desktop: false }],
          ],
        );
      } finally {
        if (saved) Object.defineProperty(navigator, "mediaDevices", saved);
        else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
      }
    };
    const pc = await remote(() => {});
    expect(pc).toMatch(/<button[^>]*>Capturar<\/button>/);
    expect(pc).not.toMatch(/<button[^>]*disabled=""[^>]*>Capturar/);
    expect(pc).toContain("Elige la pantalla o la ventana de este equipo");
    // The Mac's helper is not this device's to fix.
    expect(pc).not.toContain("Conceder permiso");
    expect(await remote()).toMatch(/<button[^>]*disabled=""[^>]*>Sin captura aquí<\/button>/);
  });
});
