import { z } from "zod";
import { storageFamily } from "../../storage.ts";
import { createStore, useStore } from "../../store.ts";

// Which file a checkout's code tile shows, and at which line: set by the tile itself (tree,
// quick open, go to definition) and from outside it (the git diff's "Abrir en Código"). The
// last file per checkout stays in this browser, so a reload reopens it.
export type Target = { path: string; line: number | null; seq: number };

const Stored = z.object({ path: z.string().min(1), line: z.number().int().positive().nullable() });
const lastFile = storageFamily("aos.code.file:", {
  schema: Stored.nullable(),
  fallback: null,
  codec: "json",
});

// `seq` grows with each open, so opening the same line again scrolls to it again.
const opened = createStore<{ seq: number; by: Readonly<Record<string, Target>> }>({
  seq: 0,
  by: {},
});

export function openIn(location: string, path: string, line: number | null = null) {
  opened.update(({ seq, by }) => ({
    seq: seq + 1,
    by: { ...by, [location]: { path, line, seq: seq + 1 } },
  }));
  lastFile.set(location, { path, line });
}

// Nothing opened in this page yet: the file kept from the last visit, at seq 0.
export function useTarget(location: string): Target | null {
  const target = useStore(opened).by[location];
  if (target) return target;
  const kept = lastFile.get(location);
  return kept && { ...kept, seq: 0 };
}
