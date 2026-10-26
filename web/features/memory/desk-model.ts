import type { SourceInfo } from "../../../server/features/memory/store.ts";
import { relativeTime } from "../../format.ts";
import { SOURCE_LABEL } from "./panel.tsx";
import { type DocSummary, HARNESS_SOURCES, type SourceId } from "./queries.ts";

export type DocsSearch = { id?: string; q?: string; v?: "dia" };

export const WRITABLE: SourceId[] = ["notes", "memory", "prompts"];
export const TICKETS_SHOWN = 8;
export const NOTES_EMPTY =
  "Aún no hay notas. Se guardan como Markdown en data/notes y data/memory.";
// Inline colours: Tailwind does not generate the color-mix() arbitrary classes.
export const LEVEL = [0, 30, 55, 80, 100].map((p) =>
  p === 0 ? "var(--hover)" : `color-mix(in oklab, var(--accent) ${p}%, var(--hover))`,
);

export const ago = (d: DocSummary, now: number) =>
  relativeTime(new Date(d.mtime).toISOString(), now);

// Every listed document, by where it lives.
export type DeskDocs = {
  notes: DocSummary[];
  prompts: DocSummary[];
  harness: DocSummary[];
  sources: SourceInfo[];
};

const sourceState = (s: SourceInfo) => (s.missing ? "no encontrada" : s.count === 0 ? "vacía" : "");

type Folder = { id: SourceId; label: string; count: number; note?: string };

// The user's notes, the app's memory and prompts, then each harness's memory, read-only.
export function foldersOf(d: DeskDocs): Folder[] {
  const count = (id: SourceId) =>
    [...d.notes, ...d.prompts, ...d.harness].filter((x) => x.source === id).length;
  return [
    { id: "notes", label: "Notas", count: count("notes") },
    { id: "memory", label: SOURCE_LABEL.memory, count: count("memory") },
    { id: "prompts", label: "Prompts", count: count("prompts") },
    ...d.sources
      .filter((s) => HARNESS_SOURCES.includes(s.id))
      .map((s) => ({ id: s.id, label: s.label, count: s.count, note: sourceState(s) })),
  ];
}
