import { useEffect, useRef } from "react";
import { z } from "zod";
import { storageKey } from "../../storage.ts";
import { createStore, useStore } from "../../store.ts";
import { dismissTerminals, raise, restore, terminalAlert } from "../alerts/alerts.ts";
import { phaseOf } from "./panel.tsx";
import { type TerminalInfo, useTerminals } from "./queries.ts";

// The terminals waiting for the user: an agent that finished its turn or asks for something,
// or any terminal that ended. Each raises an alert (web/features/alerts), the tile and its
// tree row blink, and the tab's title and the Mesa link carry the count until the user looks.
// Looking ends a finished turn's or an exit's wait, never a question's: an agent that asks
// waits until it gets its answer and works again.

type Snap = { running: boolean; agent: string | null };
export type Before = ReadonlyMap<string, Snap>;

export const snapshot = (list: TerminalInfo[]): Before =>
  new Map(
    list.map((t) => [t.id, { running: t.state === "running", agent: t.agent?.state ?? null }]),
  );

// The ones that just started to wait. A terminal seen for the first time never counts, so
// loading the page is silent.
export function newlyWaiting(before: Before, now: TerminalInfo[]): string[] {
  return now
    .filter((t) => {
      const was = before.get(t.id);
      if (!was) return false;
      if (was.running && t.state !== "running") return true;
      return t.state === "running" && was.agent === "working" && t.agent?.state === "needs_you";
    })
    .map((t) => t.id);
}

// The ones that still wait: a terminal removed, or an agent working again, waits no more.
export function stillWaiting(waiting: ReadonlySet<string>, now: TerminalInfo[]): Set<string> {
  return new Set(
    now
      .filter((t) => waiting.has(t.id) && !(t.state === "running" && t.agent?.state === "working"))
      .map((t) => t.id),
  );
}

// An agent asking a question or for a permission: it waits whether or not the user has looked.
export const isAsking = (t: TerminalInfo) => phaseOf(t).key === "asks";

// The askers not yet among `waiting`: a question that started while no tab watched, or before
// this one loaded, joins quietly.
export const unseenAsks = (waiting: ReadonlySet<string>, now: TerminalInfo[]) =>
  now.filter((t) => isAsking(t) && !waiting.has(t.id));

// The ones a reload brings back, taken out of `pending` as they settle: an agent that
// «Reiniciar todo» resumes reads as lost until its new process runs.
export function settled(pending: Set<string>, now: TerminalInfo[]): TerminalInfo[] {
  const out = now.filter((t) => pending.has(t.id) && t.state !== "lost");
  for (const t of out) pending.delete(t.id);
  return out;
}

// Kept in this browser and shared by its tabs, so a reload keeps what waits («Reiniciar todo»
// reloads the page, and the agents it resumes keep their ids) and a look in one tab counts in
// all of them.
const kept = storageKey("aos.terminals.waiting", {
  schema: z.array(z.string()),
  fallback: [],
  codec: "json",
});
const waiting = createStore<ReadonlySet<string>>(new Set(kept.get()));
// The askers in the last list read: a look does not end their wait.
const asking = createStore<ReadonlySet<string>>(new Set());

function setWaiting(next: ReadonlySet<string>, save = true) {
  const now = waiting.get();
  if (next.size === now.size && [...next].every((id) => now.has(id))) return;
  dismissTerminals((id) => next.has(id));
  waiting.set(next);
  if (save) kept.set([...next]);
}
// Another tab's change: taken as is, never written back.
kept.watch((ids) => setWaiting(new Set(ids), false));

export const useWaiting = () => useStore(waiting);
export const isWaiting = (id: string) => waiting.get().has(id);
export const useNeedsYou = (id: string) => useWaiting().has(id);

// The user looked at it: clicked or focused its tile, or opened it from the tree. A question
// keeps waiting for its answer.
export function seen(id: string) {
  if (!waiting.get().has(id) || asking.get().has(id)) return;
  const next = new Set(waiting.get());
  next.delete(id);
  setWaiting(next);
}

// Typing in that terminal, with the window in front: nothing to tell.
const lookingAt = (id: string) =>
  document.hasFocus() &&
  Boolean(document.activeElement?.closest(`[data-terminal-id="${CSS.escape(id)}"]`));

export const APP_TITLE = "Agentic OS";

// Mounted once, in the Shell: watches the list and raises the alerts, which keep the tab's title
// (features/alerts/signals.tsx).
export function Attention() {
  const list = useTerminals().data?.terminals;
  const before = useRef<Before | null>(null);
  // What waited before the page loaded, brought back silently (settled).
  const restoring = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!list) return;
    restoring.current ??= new Set(waiting.get());
    const pending = restoring.current;
    const fresh = before.current
      ? newlyWaiting(before.current, list).filter((id) => !lookingAt(id))
      : [];
    before.current = snapshot(list);
    asking.set(new Set(list.filter(isAsking).map((t) => t.id)));
    const next = stillWaiting(waiting.get(), list);
    for (const id of fresh) next.add(id);
    const quiet = unseenAsks(next, list);
    for (const t of quiet) next.add(t.id);
    setWaiting(next);
    restore([
      ...settled(pending, list)
        .filter((t) => next.has(t.id))
        .map(terminalAlert),
      ...quiet.map(terminalAlert),
    ]);
    raise(list.filter((t) => fresh.includes(t.id)).map(terminalAlert));
  }, [list]);

  return null;
}
