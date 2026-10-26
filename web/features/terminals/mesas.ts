import { useSyncExternalStore } from "react";
import { z } from "zod";
import { type SharedBlock, SharedBlocks } from "../../../shared/workspace.ts";
import { storageKey } from "../../storage.ts";
import { createStore } from "../../store.ts";
import {
  addTile,
  type GridSearch,
  gridIds,
  isPanel,
  type Layout,
  MAX_TILES,
  readLayout,
  reconcile,
} from "./grid-state.ts";
import type { TerminalInfo } from "./queries.ts";

export type MesaState = {
  id: string;
  name: string;
  ids: string[];
  layout: Layout | null;
  max?: string;
  node?: string;
  mobileId?: string;
  // Its work block (shared, like the name); none puts it in «Sin bloque».
  block?: string;
};
export type Workspace = {
  version: 1;
  activeId: string;
  mesas: MesaState[];
  // The work blocks, in the bar's order; shared across devices.
  blocks?: SharedBlock[];
};
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const mesaSchema = z.object({
  id: z.string().min(1),
  name: nameSchema,
  ids: z.array(z.string().min(1)).max(MAX_TILES),
  layout: z.unknown().transform(readLayout),
  max: z.string().min(1).optional(),
  node: z.string().min(1).optional(),
  mobileId: z.string().min(1).optional(),
  block: z.string().min(1).optional(),
});
const schema = z
  .object({
    version: z.literal(1),
    activeId: z.string(),
    mesas: z.array(mesaSchema).min(1),
    blocks: SharedBlocks.optional(),
  })
  .refine((s) => new Set(s.mesas.map((m) => m.id)).size === s.mesas.length);
const empty = (id = "mesa-1", name = "Mesa 1"): MesaState => ({ id, name, ids: [], layout: null });
const initial = (): Workspace => ({ version: 1, activeId: "mesa-1", mesas: [empty()] });
export const activeMesa = (s: Workspace, id = s.activeId): MesaState =>
  s.mesas.find((m) => m.id === id) ??
  s.mesas.find((m) => m.id === s.activeId) ??
  s.mesas[0] ??
  empty();
export const ownerOf = (s: Workspace, id: string) =>
  isPanel(id) ? undefined : s.mesas.find((m) => m.ids.includes(id));

// All membership changes use the same reconciliation as a tile added/removed in the grid.
export function updateMesa(
  s: Workspace,
  id: string,
  patch: Partial<Omit<MesaState, "id">>,
): Workspace {
  return {
    ...s,
    mesas: s.mesas.map((m) => {
      if (m.id !== id)
        return m.max && !isPanel(m.max) && patch.ids?.includes(m.max)
          ? { ...m, max: undefined }
          : m;
      const ids = patch.ids
        ? gridIds(patch.ids.join(",")).filter((t) => !ownerOf(s, t) || ownerOf(s, t)?.id === id)
        : m.ids;
      return {
        ...m,
        ...patch,
        ids,
        layout:
          patch.layout !== undefined
            ? patch.layout
            : patch.ids
              ? reconcile(m.layout, ids, { w: 960, h: 600 })
              : m.layout,
      };
    }),
  };
}
// The first "Mesa N" no other Mesa uses.
function freeName(s: Workspace, except?: string) {
  let n = 1;
  while (s.mesas.some((m) => m.id !== except && splitName(m.name).base === `Mesa ${n}`)) n++;
  return `Mesa ${n}`;
}
// A new Mesa goes in the block of the Mesa it was made from.
export function createMesa(s: Workspace, id: string, block = activeMesa(s).block): Workspace {
  if (s.mesas.some((m) => m.id === id)) return s;
  const mesa = { ...empty(id, freeName(s)), ...(block && { block }) };
  return { ...s, activeId: id, mesas: [...s.mesas, mesa] };
}

// The tabs' order is this browser's, like the tiles' layout: the shared workspace keeps
// membership and names only, so moving a tab sends nothing to the server.
export function reorderMesa(s: Workspace, id: string, index: number): Workspace {
  const from = s.mesas.findIndex((m) => m.id === id);
  const moved = s.mesas[from];
  if (!moved) return s;
  const rest = s.mesas.filter((m) => m.id !== id);
  const to = Math.max(0, Math.min(index, rest.length));
  if (to === from) return s;
  return { ...s, mesas: [...rest.slice(0, to), moved, ...rest.slice(to)] };
}

// A Mesa's emoji rides at the start of its name ("🐛 Bugs"), so it crosses devices with the
// name and the shared workspace needs no new field. A name still "Mesa N" was never chosen by
// the user: the tab shows what its terminals work on instead (autoName).
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const firstGrapheme = (value: string) =>
  segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? "";
export const isEmoji = (value: string) =>
  value !== "" && firstGrapheme(value) === value && /\p{Extended_Pictographic}/u.test(value);
export function splitName(name: string): { icon: string | null; base: string } {
  const icon = firstGrapheme(name);
  return isEmoji(icon) && name.startsWith(`${icon} `)
    ? { icon, base: name.slice(icon.length + 1) }
    : { icon: null, base: name };
}
export const isAutoName = (name: string) => /^Mesa \d+$/.test(splitName(name).base);

// An empty name gives the Mesa back its "Mesa N", so the tab follows its terminals again.
export function renameMesa(
  s: Workspace,
  id: string,
  value: string,
  icon?: string | null,
): Workspace {
  const m = s.mesas.find((x) => x.id === id);
  if (!m) return s;
  const current = splitName(m.name);
  const base = value.trim() || (isAutoName(m.name) ? current.base : freeName(s, id));
  const mark = icon === undefined ? current.icon : icon;
  if (mark && !isEmoji(mark)) return s;
  const name = nameSchema.safeParse(mark ? `${mark} ${base}` : base);
  return name.success ? updateMesa(s, id, { name: name.data }) : s;
}

// What a Mesa's terminals work on: their tickets (a terminal's `ticket` is already the one its
// objective names, else its launch ticket) and the first free-text goal.
export function mesaTopic(mesa: Pick<MesaState, "ids">, terminals: TerminalInfo[]) {
  const own = mesa.ids.flatMap((id) => terminals.filter((t) => t.id === id));
  const tickets = [...new Set(own.flatMap((t) => (t.ticket ? [t.ticket] : [])))];
  const goal = own.flatMap((t) => (t.objective?.kind === "goal" ? [t.objective.title] : []))[0];
  return { own, tickets, goal: goal ?? null };
}
// A Mesa's tickets as one badge: the first, and how many more.
export const ticketBadge = (tickets: string[]) =>
  tickets[0] ? (tickets.length > 1 ? `${tickets[0]} +${tickets.length - 1}` : tickets[0]) : null;

// What a Mesa still called "Mesa N" shows: its tickets, else its goal, else a name the user gave
// one of its terminals, else the title an agent keeps. null keeps the stored name (no such
// context, or a chosen name).
export function autoName(mesa: Pick<MesaState, "name" | "ids">, terminals: TerminalInfo[]) {
  if (!isAutoName(mesa.name)) return null;
  const { own, tickets, goal } = mesaTopic(mesa, terminals);
  return (
    ticketBadge(tickets) ??
    goal ??
    own.find((t) => t.name)?.name ??
    own.find((t) => t.agent?.title)?.agent?.title ??
    null
  );
}
// A Mesa as every list names it: its emoji, then its auto name or the one the user chose.
export function mesaTitle(mesa: Pick<MesaState, "name" | "ids">, terminals: TerminalInfo[]) {
  const { icon, base } = splitName(mesa.name);
  const label = autoName(mesa, terminals) ?? base;
  return icon ? `${icon} ${label}` : label;
}
export function closeMesa(s: Workspace, id: string): Workspace {
  const index = s.mesas.findIndex((m) => m.id === id);
  if (index < 0) return s;
  const mesas = s.mesas.filter((m) => m.id !== id);
  if (!mesas.length) return initial();
  return {
    ...s,
    mesas,
    activeId: s.activeId === id ? (mesas[Math.max(0, index - 1)] ?? empty()).id : s.activeId,
  };
}
export function moveTerminal(s: Workspace, terminal: string, target: string): Workspace {
  const to = s.mesas.find((m) => m.id === target);
  if (!to || isPanel(terminal) || to.ids.length >= MAX_TILES) return s;
  const cleared = {
    ...s,
    mesas: s.mesas.map((m) => {
      const ids = m.ids.filter((id) => id !== terminal);
      return {
        ...m,
        ids,
        max: m.max === terminal ? undefined : m.max,
        layout:
          ids.length === m.ids.length ? m.layout : reconcile(m.layout, ids, { w: 960, h: 600 }),
      };
    }),
  };
  return {
    ...updateMesa(cleared, target, {
      ids: [...to.ids.filter((id) => id !== terminal), terminal],
      max: undefined,
    }),
    activeId: target,
  };
}
export function openInMesa(s: Workspace, tile: string, origin = s.activeId): Workspace {
  const m = ownerOf(s, tile) ?? activeMesa(s, origin);
  const ids = addTile(m.ids, tile);
  return {
    ...updateMesa(s, m.id, {
      ids,
      max: m.max || !ids.includes(tile) ? tile : undefined,
      mobileId: tile,
    }),
    activeId: m.id,
  };
}

// URL imports never move a terminal implicitly. New links carry an intent (`t`), which
// resolves to its owner at navigation time, rather than a stale copy of the tile set.
export function resolveMesaSearch(s: Workspace, search: GridSearch) {
  const m = activeMesa(s, search.mesa);
  let next = { ...s, activeId: m.id };
  const omitted: string[] = [];
  if (search.ids !== undefined && !search.mesa) {
    const ids = gridIds(search.ids).filter((id) => {
      const owner = ownerOf(s, id);
      if (!owner || owner.id === m.id) return true;
      omitted.push(owner.name);
      return false;
    });
    next = updateMesa(next, m.id, { ids, max: undefined });
  }
  if (search.max !== undefined) {
    const owner = ownerOf(next, search.max);
    if (!owner || owner.id === m.id) next = updateMesa(next, m.id, { max: search.max });
  }
  if (search.t) next = openInMesa(next, search.t, m.id);
  if (search.node) next = updateMesa(next, next.activeId, { node: search.node });
  return { workspace: next, omitted: [...new Set(omitted)] };
}

// This browser's Mesas: the view of each (layout, maximised tile, phone tile) and, until the
// server answers, its membership.
const saved = storageKey("aos.mesas", { schema: z.unknown(), fallback: null, codec: "json" });
// The single grid before Mesas, imported once into the first one.
const legacyGrid = storageKey("aos.grid", { schema: z.string(), fallback: "" });
const legacyLayout = storageKey("aos.grid.layout", {
  schema: z.unknown(),
  fallback: null,
  codec: "json",
});
// The tab's active Mesa, so a reload stays on it while another tab uses another.
const activeTab = storageKey("aos.mesa.active", {
  schema: z.string(),
  fallback: "",
  area: "session",
});

function load(): Workspace {
  const parsed = schema.safeParse(saved.get());
  if (parsed.success) {
    const used = new Set<string>();
    const mesas = parsed.data.mesas.map((m) => ({
      ...m,
      ids: gridIds(m.ids.join(",")).filter((id) => {
        if (isPanel(id)) return true;
        if (used.has(id)) return false;
        used.add(id);
        return true;
      }),
    }));
    const s: Workspace = { ...parsed.data, mesas };
    return {
      ...s,
      activeId: activeMesa(s).id,
      mesas: mesas.map((m) => ({
        ...m,
        max: m.max && ownerOf(s, m.max) && ownerOf(s, m.max)?.id !== m.id ? undefined : m.max,
      })),
    };
  }
  const s = initial();
  activeMesa(s).ids = gridIds(legacyGrid.get());
  activeMesa(s).layout = readLayout(legacyLayout.get());
  return s;
}

// The Mesas read from this browser's storage; `saved` is false when a write was not kept.
export function createMesaStore() {
  const state = createStore({ workspace: load(), saved: true });
  return {
    getSnapshot: state.get,
    subscribe: state.subscribe,
    update(change: (s: Workspace) => Workspace) {
      const before = state.get();
      const workspace = change(before.workspace);
      const kept = saved.set(workspace);
      if (JSON.stringify(before.workspace) !== JSON.stringify(workspace) || kept !== before.saved)
        state.set({ workspace, saved: kept });
      return workspace;
    },
    reload: () => state.set({ workspace: load(), saved: true }),
  };
}

const store = createMesaStore();
const restored = activeTab.get();
if (restored)
  store.update((s) => (s.mesas.some((m) => m.id === restored) ? { ...s, activeId: restored } : s));
export const readMesas = () => store.getSnapshot().workspace;
// Which Mesas exist, their names and the set of tiles in each change only through an intent the
// server decides (sendIntent, workspace-sync.tsx). A view change (layout, maximise, tab order,
// active Mesa) that touches them keeps them as they were.
export function keepMembership(before: Workspace, after: Workspace): Workspace {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const at = (id: string) => {
    const i = after.mesas.findIndex((m) => m.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const mesas = before.mesas
    .map((was) => {
      const now = after.mesas.find((m) => m.id === was.id);
      return now
        ? {
            ...now,
            name: was.name,
            block: was.block,
            ids: same(now.ids, was.ids) ? now.ids : was.ids,
          }
        : was;
    })
    .sort((a, b) => at(a.id) - at(b.id));
  return {
    ...after,
    mesas,
    blocks: before.blocks,
    activeId: mesas.some((m) => m.id === after.activeId) ? after.activeId : before.activeId,
  };
}
const write = (change: (s: Workspace) => Workspace) =>
  store.update((before) => {
    const next = change(before);
    activeTab.set(next.activeId);
    return next;
  });
// A change to this browser's view of its Mesas.
export const changeMesas = (change: (s: Workspace) => Workspace) =>
  write((before) => keepMembership(before, change(before)));
// Membership too: only the sync calls it, for an intent shown before its answer and for the
// server's Mesas.
export const writeMembership = write;
export const useMesas = () =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
export function mesaSearch(at: { t?: string; node?: string; mesa?: string } = {}): GridSearch {
  const s = readMesas();
  const m = (at.t && ownerOf(s, at.t)) || activeMesa(s, at.mesa);
  return { mesa: m.id, ...(at.t && { t: at.t }), ...(at.node && { node: at.node }) };
}
