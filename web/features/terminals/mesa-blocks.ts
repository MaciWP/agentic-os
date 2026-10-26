import { BLOCK_COLORS, type BlockColor, type SharedBlock } from "../../../shared/workspace.ts";
import type { MesaState, Workspace } from "./mesas.ts";
import type { TerminalInfo } from "./queries.ts";

// The repos and envs a block suggestion reads: the projects list's own shape.
export type RepoGroups = {
  repos: { id: string; group?: string | null }[];
  envs: { repos: string[] };
};

export const blocksOf = (s: Workspace) => s.blocks ?? [];

// What each block intent shows here at once; the server's answer then decides.
export function assignMesa(s: Workspace, mesa: string, block: string | null): Workspace {
  return {
    ...s,
    mesas: s.mesas.map((m) => {
      if (m.id !== mesa) return m;
      const { block: _, ...rest } = m;
      return block ? { ...rest, block } : rest;
    }),
  };
}
export function addBlock(s: Workspace, block: SharedBlock, mesas: string[] = []): Workspace {
  const blocks = blocksOf(s).some((b) => b.id === block.id) ? blocksOf(s) : [...blocksOf(s), block];
  return {
    ...s,
    blocks,
    mesas: s.mesas.map((m) => (mesas.includes(m.id) ? { ...m, block: block.id } : m)),
  };
}
export function editBlock(
  s: Workspace,
  id: string,
  patch: { name?: string; color?: BlockColor },
): Workspace {
  return { ...s, blocks: blocksOf(s).map((b) => (b.id === id ? { ...b, ...patch } : b)) };
}
// A removed block's Mesas stay, without a block.
export function dropBlock(s: Workspace, id: string): Workspace {
  const kept = s.mesas.filter((m) => m.block === id).reduce((w, m) => assignMesa(w, m.id, null), s);
  return { ...kept, blocks: blocksOf(s).filter((b) => b.id !== id) };
}

// The project a terminal works in: its repo's group, else the repo; an env, the group of the
// repos envs are made from. null for a terminal outside the configured repos.
export function projectOf(t: TerminalInfo, p: RepoGroups): string | null {
  const [kind, id] = [t.location.split(":")[0], t.location.slice(t.location.indexOf(":") + 1)];
  if (t.harness === "env" || kind === "env") {
    const group = p.repos.find((r) => p.envs.repos.includes(r.id) && r.group)?.group;
    return group ?? null;
  }
  if (kind !== "repo") return null;
  const repo = p.repos.find((r) => r.id === id);
  return repo ? (repo.group ?? repo.id) : null;
}
function projectsOf(mesa: Pick<MesaState, "ids">, terminals: TerminalInfo[], p: RepoGroups) {
  return new Set(
    mesa.ids.flatMap((id) => {
      const t = terminals.find((x) => x.id === id);
      const project = t && projectOf(t, p);
      return project ? [project] : [];
    }),
  );
}

// The block a Mesa belongs in by its projects: the only block whose other Mesas work on one
// of them. null when none, more than one, or the block it already sits in.
export function suggestBlock(
  s: Workspace,
  mesa: MesaState,
  terminals: TerminalInfo[],
  p: RepoGroups,
): SharedBlock | null {
  const own = projectsOf(mesa, terminals, p);
  if (!own.size) return null;
  const hits = blocksOf(s).filter((b) =>
    s.mesas.some(
      (m) =>
        m.id !== mesa.id &&
        m.block === b.id &&
        [...projectsOf(m, terminals, p)].some((project) => own.has(project)),
    ),
  );
  const [only] = hits;
  return hits.length === 1 && only && only.id !== mesa.block ? only : null;
}

export type Proposal = { key: string; name: string; color: BlockColor; mesas: string[] };
// A first set of blocks: one per project the Mesas outside a block work on, biggest first.
// A Mesa on several projects goes with the first; one on none stays out.
export function seedBlocks(s: Workspace, terminals: TerminalInfo[], p: RepoGroups): Proposal[] {
  const by = new Map<string, string[]>();
  for (const m of s.mesas) {
    if (m.block && blocksOf(s).some((b) => b.id === m.block)) continue;
    const [first] = projectsOf(m, terminals, p);
    if (first) by.set(first, [...(by.get(first) ?? []), m.id]);
  }
  const used = new Set(blocksOf(s).map((b) => b.color));
  const free = [...BLOCK_COLORS.filter((c) => !used.has(c)), ...BLOCK_COLORS];
  return [...by]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, mesas], i) => ({
      key,
      name: key.slice(0, 40),
      color: free[i % free.length] ?? "slate",
      mesas,
    }));
}
// Merges proposal `from` into `into` (the «Unir con…» choice).
export function mergeProposal(list: Proposal[], from: string, into: string): Proposal[] {
  const source = list.find((x) => x.key === from);
  if (!source || from === into) return list;
  return list
    .filter((x) => x.key !== from)
    .map((x) => (x.key === into ? { ...x, mesas: [...x.mesas, ...source.mesas] } : x));
}

// The rail's groups, by where each Mesa stands (its most pressing terminal, panel.tsx
// `standingRank`): what waits on the user, what runs, what is done. Inside «Te esperan» the most
// pressing go first; otherwise, and on ties, the list's own order holds. Empty groups go.
export const STATE_GROUPS = [
  { key: "waits", name: "Te esperan" },
  { key: "runs", name: "En marcha" },
  { key: "done", name: "Terminadas" },
] as const;
export type StateGroup = (typeof STATE_GROUPS)[number]["key"];
export const groupOfRank = (rank: number): StateGroup =>
  rank <= 3 ? "waits" : rank <= 5 ? "runs" : "done";
export function groupByState<T>(items: T[], rank: (item: T) => number) {
  return STATE_GROUPS.map((g) => ({
    ...g,
    items: items
      .map((item, at) => ({ item, at, rank: rank(item) }))
      .filter((x) => groupOfRank(x.rank) === g.key)
      .sort((a, b) => (g.key === "waits" ? a.rank - b.rank : 0) || a.at - b.at)
      .map((x) => x.item),
  })).filter((g) => g.items.length > 0);
}

// The Mesas by block, in the blocks' order, and those without one (or with one gone) last as
// «Sin bloque»; inside each, the list's own order. Empty bands go.
export function byBlock<T extends { mesa: MesaState }>(items: T[], s: Workspace) {
  const blocks = blocksOf(s);
  const known = new Set(blocks.map((b) => b.id));
  return [
    ...blocks.map((b) => ({
      key: b.id,
      name: b.name,
      color: b.color as BlockColor | null,
      items: items.filter((x) => x.mesa.block === b.id),
    })),
    {
      key: "",
      name: "Sin bloque",
      color: null,
      items: items.filter((x) => !x.mesa.block || !known.has(x.mesa.block)),
    },
  ].filter((band) => band.items.length > 0);
}
