import { z } from "zod";
import {
  type DiffNote,
  MAX_BRING_NOTES,
  MAX_NOTE_LINES,
  NOTE_KINDS,
  type NoteKind,
} from "../../../shared/terminals.ts";
import { mutate } from "../../api.ts";
import { storageFamily } from "../../storage.ts";
import { createStore, useStore } from "../../store.ts";
import type { DiffLine } from "./diff.ts";

// Notes on a checkout's diff, written in the git tile and sent at once to an agent working in
// that checkout ("Llevar a terminal" with the notes as its content). Each note keeps the diff
// lines it was written on, with their +/-/space mark: they anchor it while line numbers move,
// and tell whether the agent touched them after it got the note.
export type Note = {
  id: string;
  path: string;
  // The side of the diff it was written on: the unstaged and the staged diff differ.
  staged: boolean;
  // Diff lines as parsed (`DiffLine.text`): mark and content.
  lines: string[];
  side: "old" | "new";
  start: number;
  end: number;
  kind: NoteKind;
  text: string;
  created: number;
  sent: number | null;
};

export const KIND_LABEL: Record<NoteKind, string> = {
  change: "cambio",
  question: "pregunta",
  nit: "nit",
  keep: "no tocar",
};
export const PHRASES = [
  "Fuera de alcance del ticket.",
  "¿Dónde más se usa? Comprueba que no rompe otros usos.",
  "Hazlo más simple, con menos líneas.",
  "Añade un test que lo cubra.",
];

const MAX_KEPT = 200;
const SENT_TTL_MS = 7 * 24 * 3600 * 1000;

const Stored = z.array(
  z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    staged: z.boolean(),
    lines: z.array(z.string()).min(1).max(MAX_NOTE_LINES),
    side: z.enum(["old", "new"]),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    kind: z.enum(NOTE_KINDS),
    text: z.string().min(1),
    created: z.number(),
    sent: z.number().nullable(),
  }),
);
const kept = storageFamily("aos.diff-notes:", { schema: Stored, fallback: [], codec: "json" });

// Every checkout's notes changed in this page; one never changed here is read from storage.
const notes = createStore<Readonly<Record<string, readonly Note[]>>>({});

// Sent notes older than a week go; the newest MAX_KEPT stay.
export const prune = (list: readonly Note[], now: number) =>
  list.filter((n) => n.sent === null || now - n.sent < SENT_TTL_MS).slice(-MAX_KEPT);

export const notesOf = (location: string): readonly Note[] =>
  notes.get()[location] ?? prune(kept.get(location), Date.now());

function write(location: string, change: (list: readonly Note[]) => readonly Note[]) {
  const next = prune(change(notesOf(location)), Date.now());
  notes.update((all) => ({ ...all, [location]: next }));
  kept.set(location, [...next]);
}

export function useNotes(location: string): readonly Note[] {
  useStore(notes);
  return notesOf(location);
}

const numberOf = (l: DiffLine, side: "old" | "new") => (side === "old" ? l.old : l.new);

// The note for diff lines `from..to` (indices of one hunk's lines), or null when the range
// holds no file line or is too long.
export function draftFrom(
  lines: readonly DiffLine[],
  from: number,
  to: number,
): Pick<Note, "lines" | "side" | "start" | "end"> | null {
  const picked = lines.slice(Math.min(from, to), Math.max(from, to) + 1);
  if (picked.length === 0 || picked.length > MAX_NOTE_LINES) return null;
  if (picked.some((l) => l.kind === "hunk" || l.kind === "meta")) return null;
  // A range of removed lines only is about the old file; anything else, the new one.
  const side = picked.every((l) => l.kind === "del") ? "old" : "new";
  const nums = picked.map((l) => numberOf(l, side)).filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  return {
    lines: picked.map((l) => l.text),
    side,
    start: Math.min(...nums),
    end: Math.max(...nums),
  };
}

export function addNote(location: string, note: Omit<Note, "id" | "created" | "sent">) {
  const created = Date.now();
  write(location, (list) => [
    ...list,
    { ...note, id: `${created}-${Math.random().toString(36).slice(2, 8)}`, created, sent: null },
  ]);
}

export const removeNote = (location: string, id: string) =>
  write(location, (list) => list.filter((n) => n.id !== id));

export const clearSent = (location: string) =>
  write(location, (list) => list.filter((n) => n.sent === null));

export const pendingOf = (list: readonly Note[]) => list.filter((n) => n.sent === null);

// Pending notes per file row of the git tile, keyed as the row is: `w:` or `s:` and the path.
export function noteCounts(list: readonly Note[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const n of pendingOf(list)) {
    const key = `${n.staged ? "s" : "w"}:${n.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Where a note sits in a diff: the index of the last of its lines, when they are all there in
// a row, with the same marks; else -1.
export function anchorOf(note: Note, lines: readonly DiffLine[]): number {
  const first = note.lines[0];
  for (let i = 0; i + note.lines.length <= lines.length; i++) {
    if (lines[i]?.text !== first) continue;
    if (note.lines.every((t, k) => lines[i + k]?.text === t)) return i + note.lines.length - 1;
  }
  return -1;
}

// What happened to a sent note: its lines still in the diff of its side ("untouched"), or
// not ("touched"). Touched says the lines changed, not that the change is right.
// ponytail: compares with the side's diff only, so staging the lines reads as touched; check
// both sides when a staged note shows up as touched by mistake.
export type NoteStatus = "pending" | "sent" | "touched" | "untouched";
export function noteStatus(note: Note, lines: readonly DiffLine[] | null): NoteStatus {
  if (note.sent === null) return "pending";
  if (lines === null) return "sent";
  return anchorOf(note, lines) >= 0 ? "untouched" : "touched";
}

// The notes as the server takes them, in file order, oldest first within each file.
export function payload(list: readonly Note[]): DiffNote[] {
  return list.slice(0, MAX_BRING_NOTES).map((n) => ({
    path: n.path,
    side: n.side,
    start: n.start,
    end: n.end,
    quote: n.lines.map((t) => t.slice(1)),
    kind: n.kind,
    text: n.text,
  }));
}

// Pastes the checkout's pending notes into a terminal, never followed by Enter, and marks them
// sent once the server says they went.
export async function sendNotes(location: string, terminal: string) {
  const list = pendingOf(notesOf(location)).slice(0, MAX_BRING_NOTES);
  if (list.length === 0) return;
  await mutate<{ sent: boolean }>(`/api/terminals/${encodeURIComponent(terminal)}/bring`, "POST", {
    notes: payload(list),
  });
  const ids = new Set(list.map((n) => n.id));
  const now = Date.now();
  write(location, (all) => all.map((n) => (ids.has(n.id) ? { ...n, sent: now } : n)));
}
