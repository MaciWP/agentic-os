import { createHash } from "node:crypto";
import type { Meeting } from "../../../shared/meetings.ts";
import { fileName, MemoryError, type MemoryStore } from "../memory/store.ts";
import type { MeetingStore } from "./store.ts";

// One Markdown note per meeting, in the user's Notas. The name is the local day and a hash of
// the calendar's event, so the same meeting always names the same note and two meetings with
// one title never share it.

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function noteName(m: Meeting): string {
  const hash = createHash("sha256")
    .update(`${m.source}|${m.eventKey}|${m.occurrence ?? ""}`)
    .digest("hex")
    .slice(0, 8);
  return `Reunion ${localDay(new Date(m.start))} ${hash}`;
}

export function noteTemplate(m: Meeting, attendees: string[]): string {
  const at = new Date(m.start);
  const when = m.allDay
    ? at.toLocaleDateString("es-ES")
    : `${at.toLocaleDateString("es-ES")} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const people = attendees.length > 0 ? attendees.map((a) => `- ${a}`).join("\n") : "- ";
  return [
    `# Reunión · ${m.title ?? "(sin título)"} · ${when}`,
    "",
    "## Asistentes",
    people,
    "",
    "## Notas",
    "",
    "",
    "## Acuerdos",
    "",
    "",
    "## Tareas",
    "- [ ] ",
    "",
  ].join("\n");
}

// The meeting's note: the linked one while it exists, else made now (or found, when a note of
// that name is already in Notas) and linked.
export async function meetingNote(
  meetings: MeetingStore,
  memory: MemoryStore,
  id: number,
  attendees: string[],
): Promise<{ meeting: Meeting; noteId: string }> {
  const m = meetings.get(id);
  if (m.noteId && (await memory.row(m.noteId))) return { meeting: m, noteId: m.noteId };
  const name = noteName(m);
  const noteId = await memory
    .create("notes", name, noteTemplate(m, attendees))
    .then((doc) => doc.id)
    .catch((err) => {
      if (err instanceof MemoryError && err.code === "exists") return `notes:${fileName(name)}`;
      throw err;
    });
  return { meeting: meetings.setNote(id, noteId), noteId };
}
