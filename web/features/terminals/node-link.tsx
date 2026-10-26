import { Link, useNavigate } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { mesaSearch } from "./mesas.ts";
import { useMesa } from "./place.ts";

// A link to a tree node, or to one of its terminals with `t`, both in the Mesa: the node is
// marked and unfolded in the tree and the terminal joins the tiles. Inside the Mesa a terminal
// link keeps the node already marked.
export function NodeLink({
  node,
  t,
  children,
  ...rest
}: { node: string; t?: string; children: ReactNode } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
>) {
  const mesa = useMesa();
  const search = mesaSearch({ mesa: mesa?.id, node: t && mesa ? mesa.node : node, t });
  return (
    <Link to="/terminales" search={search} {...rest}>
      {children}
    </Link>
  );
}

// Opens a panel tile: inside the Mesa it is brought into sight; elsewhere it goes there with
// the last grid, marking `node` in the tree.
export function useOpenTile() {
  const navigate = useNavigate();
  const mesa = useMesa();
  return (id: string, node?: string) =>
    mesa
      ? mesa.openTile(id)
      : void navigate({ to: "/terminales", search: mesaSearch({ t: id, node }) });
}

// Go to a node after a write (a new worktree, a removed one).
export function useShowNode() {
  const navigate = useNavigate();
  const mesa = useMesa();
  return (node: string) => {
    return navigate({ to: "/terminales", search: mesaSearch({ mesa: mesa?.id, node }) });
  };
}
