import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, unwrap } from "../../api.ts";
import { codeTile } from "../terminals/grid-state.ts";
import { useOpenTile } from "../terminals/node-link.tsx";
import { openIn } from "./open.ts";

// A file asked for from outside the page (server/features/code/reveal.ts): the "reveal" event
// reads the ask again and the code tile opens it, as the git diff's "Abrir en Código" does.
// Mounted once, in the Shell; each ask opens once per page, by its id.
export function useReveal() {
  const openTile = useOpenTile();
  const { data } = useQuery({
    queryKey: ["reveal"],
    queryFn: async () => unwrap(await api.api.code.reveal.$get()),
  });
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!data || data.id === seen.current) return;
    seen.current = data.id;
    openIn(data.location, data.path, data.line);
    openTile(codeTile(data.location), data.location);
  }, [data, openTile]);
}
