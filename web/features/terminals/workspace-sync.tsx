import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useEffect } from "react";
import { z } from "zod";
import {
  isPanelId,
  MAX_MEMBERS,
  membership,
  type WorkspaceCommand,
  type WorkspaceIntent,
  WorkspaceSnapshot,
} from "../../../shared/workspace.ts";
import { readAccess } from "../../access.ts";
import { machineUrl } from "../../machine.ts";
import { storageKey } from "../../storage.ts";
import { createStore, useStore } from "../../store.ts";
import { reconcile } from "./grid-state.ts";
import { readMesas, type Workspace, writeMembership } from "./mesas.ts";

export const WorkspaceReady = createContext(true);
// Only membership crosses devices. Layout, focus, active mesa and the tabs' order stay in
// this browser; a Mesa new to it goes last.
export function mergeWorkspace(local: Workspace, remote: WorkspaceSnapshot): Workspace {
  if (!remote.mesas.length) return local;
  const at = (id: string) => {
    const i = local.mesas.findIndex((m) => m.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return {
    ...local,
    blocks: remote.blocks,
    activeId: remote.mesas.some((m) => m.id === local.activeId)
      ? local.activeId
      : (remote.mesas[0]?.id ?? local.activeId),
    mesas: [...remote.mesas]
      .sort((a, b) => at(a.id) - at(b.id))
      .map((m) => {
        const view = local.mesas.find((l) => l.id === m.id);
        return {
          ...view,
          ...m,
          // A Mesa taken out of its block on the server has no `block` key to overwrite it.
          block: m.block,
          max: view?.max && m.ids.includes(view.max) ? view.max : undefined,
          layout: reconcile(view?.layout ?? null, m.ids, { w: 960, h: 600 }),
        };
      }),
  };
}

// A request the server has not confirmed: a retry sends it again with the same id, so the
// server answers what it already did instead of doing it twice.
type Unconfirmed = { command: WorkspaceCommand; label: string };
type Sync = {
  ready: boolean;
  // Requests on their way. The server's Mesas replace this browser's only when none is left,
  // so an answer never undoes a change sent after it.
  sending: number;
  error: string | null;
  unconfirmed: Unconfirmed[];
  // The newest state the server answered or pushed.
  remote: WorkspaceSnapshot | null;
};
// Exported for the tests, which read it and start each case from a clean one.
export const workspaceSync = createStore<Sync>({
  ready: false,
  sending: 0,
  error: null,
  unconfirmed: [],
  remote: null,
});
const sync = workspaceSync;
const patch = (change: Partial<Sync> | ((s: Sync) => Partial<Sync>)) =>
  sync.update((s) => ({ ...s, ...(typeof change === "function" ? change(s) : change) }));
// This browser's Mesas as they were before its first import, kept once in case it went wrong.
const beforeSync = storageKey("aos.mesas.before-sync", {
  schema: z.unknown(),
  fallback: null,
  codec: "json",
});
const NOT_CONFIRMED =
  "No se ha confirmado el cambio. Reintenta la misma petición para comprobarlo.";
const Refusal = z.object({ error: z.string(), current: WorkspaceSnapshot.optional() });

const blockName = (id: string, remote: WorkspaceSnapshot | null) =>
  remote?.blocks.find((b) => b.id === id)?.name ??
  readMesas().blocks?.find((b) => b.id === id)?.name ??
  "el bloque";
const mesaName = (id: string, remote: WorkspaceSnapshot | null) =>
  remote?.mesas.find((m) => m.id === id)?.name ??
  readMesas().mesas.find((m) => m.id === id)?.name ??
  "la Mesa";
// What a pending intent says in the list under a failure.
export function intentLabel(intent: WorkspaceIntent, remote: WorkspaceSnapshot | null): string {
  switch (intent.kind) {
    case "block-create":
      return `Crear el bloque «${intent.name}»`;
    case "block-update":
      return `Cambiar el bloque «${intent.name ?? blockName(intent.block, remote)}»`;
    case "block-remove":
      return `Borrar el bloque «${blockName(intent.block, remote)}»`;
    case "block-move":
      return `Mover el bloque «${blockName(intent.block, remote)}»`;
  }
  const name = `«${mesaName(intent.mesa, remote)}»`;
  const what = (tile: string) => (isPanelId(tile) ? "un panel" : "una terminal");
  switch (intent.kind) {
    case "add":
      return `Abrir ${what(intent.tile)} en ${name}`;
    case "remove":
      return `Quitar ${what(intent.tile)} de ${name}`;
    case "move":
      return `Llevar ${what(intent.tile)} a ${name}`;
    case "create":
      return `Crear «${intent.name}»`;
    case "close":
      return `Cerrar ${name}`;
    case "rename":
      return `Renombrar a «${intent.name}»`;
    case "assign":
      return intent.block
        ? `Llevar ${name} a «${blockName(intent.block, remote)}»`
        : `Sacar ${name} de su bloque`;
  }
}
// Why the server refused an intent, in the user's words; `current` is the state it met.
export function refusalText(
  code: string,
  intent: WorkspaceIntent,
  current: WorkspaceSnapshot | null,
): string {
  if (code === "terminal_elsewhere" && "tile" in intent) {
    const tile = intent.tile;
    const owner = tile && current?.mesas.find((m) => m.ids.includes(tile));
    if (owner) return `La terminal ya estaba en «${owner.name}».`;
  }
  if (code === "block_missing") return "El bloque ya no existe: se ha borrado en otro dispositivo.";
  if (code === "blocks_full") return "Ya hay demasiados bloques: borra uno antes.";
  if (code === "mesa_full" && "mesa" in intent)
    return `«${mesaName(intent.mesa, current)}» ya tiene ${MAX_MEMBERS} paneles: quita uno antes.`;
  if (code === "mesa_missing") return "La Mesa ya no existe: se ha cerrado en otro dispositivo.";
  return `No se ha aplicado el cambio (${code}).`;
}

function learn(next: WorkspaceSnapshot) {
  patch((s) =>
    s.remote && next.revision < s.remote.revision
      ? {}
      : { remote: next, ready: s.ready || next.mesas.length > 0 },
  );
}
function settle() {
  const { remote, sending, unconfirmed } = sync.get();
  if (!remote?.mesas.length || sending || unconfirmed.length) return;
  writeMembership((local) => mergeWorkspace(local, remote));
}
async function deliver(item: Unconfirmed) {
  const { action } = item.command;
  const intent = action.kind === "intent" ? action.intent : undefined;
  patch((s) => ({ sending: s.sending + 1 }));
  const drop = () =>
    patch((s) => ({
      unconfirmed: s.unconfirmed.filter((u) => u.command.requestId !== item.command.requestId),
    }));
  try {
    const response = await fetch(machineUrl("/api/workspace/commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item.command),
    });
    const body: unknown = await response.json().catch(() => null);
    const refusal = Refusal.safeParse(body);
    if (response.ok) {
      learn(WorkspaceSnapshot.parse(body));
      drop();
      patch((s) => (s.unconfirmed.length ? {} : { error: null }));
    } else if (response.status === 409 && refusal.success) {
      // Refused, not lost: the server's state wins and nothing is kept to send again.
      if (refusal.data.current) learn(refusal.data.current);
      drop();
      if (refusal.data.error !== "already_initialized")
        patch({
          error: intent
            ? refusalText(refusal.data.error, intent, refusal.data.current ?? sync.get().remote)
            : `No se ha aplicado el cambio (${refusal.data.error}).`,
        });
    } else throw new Error(`workspace command ${response.status}`);
  } catch {
    patch((s) => ({
      error: NOT_CONFIRMED,
      unconfirmed: s.unconfirmed.some((u) => u.command.requestId === item.command.requestId)
        ? s.unconfirmed
        : [...s.unconfirmed, item],
    }));
  } finally {
    patch((s) => ({ sending: s.sending - 1 }));
    settle();
  }
}

// Shows `change` here at once and asks the server for `intent`; the server's answer then
// decides. The only way a browser changes which terminals sit in which Mesa.
export function sendIntent(
  intent: WorkspaceIntent,
  change: (s: Workspace) => Workspace,
): Workspace {
  const { remote } = sync.get();
  if (!remote?.mesas.length) {
    patch({
      error: "Las mesas compartidas aún no se han cargado. No se ha aplicado tu último cambio.",
    });
    return readMesas();
  }
  const next = writeMembership(change);
  void deliver({
    command: { requestId: crypto.randomUUID(), action: { kind: "intent", intent } },
    label: intentLabel(intent, remote),
  });
  return next;
}
// One intent per tile a Mesa gains or loses between two of its tile lists (a legacy link).
export function tileIntents(mesa: string, before: string[], after: string[]): WorkspaceIntent[] {
  return [
    ...before
      .filter((t) => !after.includes(t))
      .map((tile) => ({ kind: "remove" as const, mesa, tile })),
    ...after
      .filter((t) => !before.includes(t))
      .map((tile) => ({ kind: "add" as const, mesa, tile })),
  ];
}

// Sends every unconfirmed request again, each with its own id; with none, reads the server again.
export function retryWorkspace(readAgain: () => void) {
  if (sync.get().sending) return;
  patch({ error: null });
  const { unconfirmed } = sync.get();
  if (!unconfirmed.length) readAgain();
  for (const item of unconfirmed) void deliver(item);
}
// Gives up the unconfirmed requests and shows the server's Mesas.
export function discardWorkspace(readAgain: () => void) {
  if (sync.get().sending) return;
  patch({ unconfirmed: [], error: null });
  settle();
  readAgain();
}

// The hook's entry for each snapshot the server sends (tests call it too).
export async function receive(next: WorkspaceSnapshot) {
  learn(next);
  if (next.mesas.length) {
    settle();
    patch((s) => (s.unconfirmed.length ? {} : { error: null }));
    return;
  }
  const access = await readAccess();
  if (sync.get().remote?.mesas.length) return;
  if (access.remote) {
    patch({ error: "Abre primero Agentic OS en el Mac para importar sus mesas." });
    return;
  }
  if (beforeSync.get() === null) beforeSync.set(readMesas());
  await deliver({
    command: {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      // Blocks travel with the Mesas that name them, so the import stays whole.
      action: {
        kind: "import",
        mesas: membership(readMesas().mesas),
        blocks: readMesas().blocks ?? [],
      },
    },
    label: "Importar las mesas de este navegador",
  });
}

export function useWorkspaceSync() {
  const q = useQuery({
    queryKey: ["workspace"],
    queryFn: async () => {
      const response = await fetch(machineUrl("/api/workspace"));
      if (!response.ok) throw new Error("No se pueden leer las mesas compartidas.");
      return WorkspaceSnapshot.parse(await response.json());
    },
    staleTime: Infinity,
  });
  useEffect(() => {
    if (q.data)
      void receive(q.data).catch(() => patch({ error: "No se pueden sincronizar las mesas." }));
    if (q.isError) patch({ error: "No se pueden leer las mesas compartidas." });
  }, [q.data, q.isError]);
  return useStore(sync).ready;
}
export function WorkspaceNotice() {
  const s = useStore(sync);
  const client = useQueryClient();
  if (s.ready && !s.error) return null;
  const invalidate = () => void client.invalidateQueries({ queryKey: ["workspace"] });
  return (
    <div
      role={s.error ? "alert" : "status"}
      className="shrink-0 border-b border-line bg-panel px-3 py-2 text-[12px]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>{s.error ?? "Cargando mesas compartidas…"}</span>
        {s.error && (
          <>
            <button type="button" className="btn" onClick={() => retryWorkspace(invalidate)}>
              Reintentar
            </button>
            {s.unconfirmed.length > 0 && (
              <button type="button" className="btn" onClick={() => discardWorkspace(invalidate)}>
                Usar las mesas del servidor
              </button>
            )}
          </>
        )}
      </div>
      {s.error && s.unconfirmed.length > 0 && (
        <ul className="max-h-28 overflow-auto">
          {[...new Set(s.unconfirmed.map((u) => u.label))].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
