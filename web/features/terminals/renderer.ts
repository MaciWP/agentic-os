import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { z } from "zod";
import { storageKey } from "../../storage.ts";
import { createStore, useStore } from "../../store.ts";

// Which renderer draws the terminals, chosen per browser in the system panel: "auto" (the
// GPU when it is a real one), "gpu" (WebGL even on an emulated GPU, to measure it) or "dom"
// (the CPU). The e2e tests ask for "dom", since they read the text from its rows.
export type RendererChoice = "auto" | "gpu" | "dom";

// A GPU emulated on the CPU (Chrome's SwiftShader, Mesa's llvmpipe, Windows' Basic Render
// Driver) costs many times what the DOM renderer does: measured 470 % of a core against 18 %
// for six busy terminals.
export const softwareGl = (renderer: string) =>
  /swiftshader|llvmpipe|softpipe|basic render|software/i.test(renderer);

export const storedChoice = storageKey("aos.terminal-renderer", {
  schema: z.enum(["auto", "gpu", "dom"]),
  fallback: "auto",
  legacy: "terminal-renderer",
});

// xterm's default DOM renderer lays out every changed row again; a Mesa of agents redrawing
// their status keeps the CPU busy. WebGL draws the same cells on the GPU: measured on an M3,
// the page's process went from 25 % to 9 % of a core for six terminals redrawing 15 lines
// 12 times a second. Without WebGL2 there is only the DOM.
export const wantsGpu = (choice: RendererChoice, gpuName: string | null) =>
  gpuName !== null && (choice === "gpu" || (choice === "auto" && !softwareGl(gpuName)));

// The GPU's name as WebGL reports it, or null without WebGL2. Asked once per page; the probe's
// context is let go at once, since a page gets only a few.
const probed = createStore<string | null | undefined>(undefined);
function gpu(): string | null {
  const known = probed.get();
  if (known !== undefined) return known;
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  const name = gl
    ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    : null;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  probed.set(name);
  return name;
}

// Kept in memory too: a browser that refuses storage still switches for this page.
const chosen = createStore<RendererChoice | undefined>(undefined);
const choice = (): RendererChoice => chosen.get() ?? storedChoice.get();

// Every terminal of this page and its WebGL addon, null while the DOM draws it.
const drawn = new Map<Terminal, WebglAddon | null>();
const loading = new Set<Terminal>();
// The addon takes its canvas off the page but leaves the context to the garbage collector, and
// a page gets 16: every Mesa switch kept one more alive.
const contexts = new WeakMap<WebglAddon, WebGL2RenderingContext>();

// Disposed first, so the addon frees its textures and buffers while the context still works.
function letGo(addon: WebglAddon | null | undefined) {
  if (!addon) return;
  addon.dispose();
  contexts.get(addon)?.getExtension("WEBGL_lose_context")?.loseContext();
}

export type RendererState = {
  choice: RendererChoice;
  gpuName: string | null;
  onGpu: number;
  total: number;
};
const state = createStore<RendererState | null>(null);

function changed() {
  state.set({
    choice: choice(),
    gpuName: gpu(),
    onGpu: [...drawn.values()].filter(Boolean).length,
    total: drawn.size,
  });
}

// Rendered on the server (unit tests) no terminal draws yet. In a browser the first reader
// probes the GPU, before it subscribes: anyone subscribed earlier has read it already.
export const NO_TERMINALS: RendererState = { choice: "auto", gpuName: null, onGpu: 0, total: 0 };
export function useRenderer() {
  if (!state.get() && typeof document !== "undefined") changed();
  return useStore(state) ?? NO_TERMINALS;
}

// Puts the terminal on the renderer the choice asks for. The addon is fetched only where it
// draws: a phone or a PC without a GPU never downloads it, and the DOM draws until it arrives.
// A lost context (a GPU reset, or past the browser's limit per page) leaves the DOM.
function apply(term: Terminal) {
  const addon = drawn.get(term);
  if (!wantsGpu(choice(), gpu())) {
    letGo(addon);
    drawn.set(term, null);
    return;
  }
  if (addon || loading.has(term)) return;
  loading.add(term);
  void import("@xterm/addon-webgl")
    .then(({ WebglAddon }) => {
      const el = term.element;
      if (drawn.get(term) !== null || !el?.isConnected) return;
      if (!wantsGpu(choice(), gpu())) return;
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (drawn.get(term) !== webgl) return;
        drawn.set(term, null);
        changed();
      });
      const before = new Set(el.querySelectorAll("canvas"));
      term.loadAddon(webgl);
      // Only the addon's new canvases are asked: on a canvas without a context, getContext
      // would make one. Its 2D link layer answers null.
      for (const canvas of el.querySelectorAll("canvas")) {
        const gl = before.has(canvas) ? null : canvas.getContext("webgl2");
        if (gl) contexts.set(webgl, gl);
      }
      drawn.set(term, webgl);
      changed();
    })
    .catch((err) => console.warn("terminal: WebGL unavailable, drawing with the DOM", err))
    .finally(() => loading.delete(term));
}

// Draws a new terminal with the chosen renderer; the returned function, called after
// `term.dispose()` (an addon disposed before it would hand the terminal a DOM renderer first),
// forgets it and lets its context go.
export function drawOnGpu(term: Terminal) {
  drawn.set(term, null);
  apply(term);
  changed();
  return () => {
    letGo(drawn.get(term));
    drawn.delete(term);
    changed();
  };
}

// Switches every terminal of this page at once, and the next ones of this browser.
export function setRendererChoice(next: RendererChoice) {
  chosen.set(next);
  if (next === "auto") storedChoice.remove();
  else storedChoice.set(next);
  for (const term of drawn.keys()) apply(term);
  changed();
}
