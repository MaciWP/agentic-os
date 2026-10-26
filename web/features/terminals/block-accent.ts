import { useEffect } from "react";
import { activeMesa, useMesas, type Workspace } from "./mesas.ts";

// The app's accent is the active Mesa's work block (tokens.css `:root[data-accent]`), the same
// colour as its dot in the rail; a Mesa with no block keeps the default violet.
export const accentOf = (s: Workspace) => {
  const block = activeMesa(s).block;
  return (block && s.blocks?.find((b) => b.id === block)?.color) || null;
};

// Mounted once, in the Shell: every page takes the accent of the last Mesa used.
export function useBlockAccent() {
  const color = accentOf(useMesas().workspace);
  useEffect(() => {
    const root = document.documentElement;
    if (color) root.dataset.accent = color;
    else delete root.dataset.accent;
  }, [color]);
}
