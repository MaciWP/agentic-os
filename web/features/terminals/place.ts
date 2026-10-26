import { createContext, useContext } from "react";
import type { TerminalInfo } from "./queries.ts";

// The Mesa a tree, a launch or a terminal link lands in. Outside it nothing is provided and they
// go to the Mesa with the last grid; inside it they keep its tiles: a terminal becomes a tile
// and a node is marked in the tree.
export type Mesa = {
  id?: string;
  move?: (terminal: string, target: string) => void;
  ids: string[];
  max?: string;
  node?: string;
  open: (t: TerminalInfo) => void;
  // A panel tile (a checkout's git, an env's output) by its id, always brought into sight.
  openTile: (id: string) => void;
};

export const MesaContext = createContext<Mesa | null>(null);
export const useMesa = () => useContext(MesaContext);
