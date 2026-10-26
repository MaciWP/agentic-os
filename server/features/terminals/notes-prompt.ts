import type { DiffNote, NoteKind } from "../../../shared/terminals.ts";
import { BRING, quoted } from "./ticket-prompt.ts";

const clean = quoted("notes");
const KIND: Record<NoteKind, string> = {
  change: "change",
  question: "question",
  nit: "nit",
  keep: "keep as is",
};

const lines = (n: DiffNote) => {
  const at = n.start === n.end ? `line ${n.start}` : `lines ${n.start}-${n.end}`;
  return n.side === "old" ? `${at} (removed)` : at;
};

// Review notes on a checkout's diff, grouped by file in reading order. The heading names the
// terminal's own location, never one the page sent. Content only, like a ticket or a PR: the
// notes are the user's instructions, so nothing is added to them.
export function notesContext(location: string, notes: DiffNote[]): string {
  const byFile = new Map<string, DiffNote[]>();
  for (const n of notes) byFile.set(n.path, [...(byFile.get(n.path) ?? []), n]);
  const out = [
    `Review notes on the diff in ${clean(location)}. Each note quotes the lines it is about;`,
    "line numbers are from when the note was written.",
    "",
    "<notes>",
  ];
  let k = 0;
  for (const [path, list] of byFile) {
    out.push("", clean(path));
    for (const n of [...list].sort((a, b) => a.start - b.start)) {
      out.push(`${++k}. [${KIND[n.kind]}] ${lines(n)}`);
      for (const q of n.quote) out.push(`   > ${clean(q)}`);
      for (const t of clean(n.text).split("\n")) out.push(`   ${t}`);
    }
  }
  out.push("</notes>");
  return BRING.check(out.join("\n"));
}
