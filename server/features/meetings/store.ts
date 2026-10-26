import type { Database } from "bun:sqlite";
import type { Meeting, MeetingSync } from "../../../shared/meetings.ts";
import { Listeners } from "../../listeners.ts";

export class MeetingError extends Error {
  readonly status = 404 as const;
  readonly code = "not_found" as const;
}

type Row = {
  id: number;
  source: "google" | "outlook";
  event_key: string;
  occurrence: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  all_day: 0 | 1;
  note_id: string | null;
  closed_at: string | null;
};
const COLUMNS =
  "id, source, event_key, occurrence, title, starts_at, ends_at, all_day, note_id, closed_at";
const meetingOf = (r: Row): Meeting => ({
  id: r.id,
  source: r.source,
  eventKey: r.event_key,
  occurrence: r.occurrence || null,
  title: r.title,
  start: r.starts_at,
  end: r.ends_at,
  allDay: r.all_day === 1,
  noteId: r.note_id,
  closedAt: r.closed_at,
});

// An all-day event starts on a date; as an instant it is that local day's midnight, so it
// sorts and filters with the timed ones.
const instant = (start: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(start)
    ? new Date(`${start}T00:00:00`).toISOString()
    : new Date(start).toISOString();

// The meetings «Hoy» keeps (ADR 0013: the server owns this table). Nothing closes on its own.
export class MeetingStore {
  private readonly listeners = new Listeners();

  constructor(private readonly db: Database) {}

  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  // Records one day's events and answers that day's meetings, in start order: a calendar that
  // failed this time still shows what it said last. A title or time the calendar changed is
  // updated; the user's note and close stay. A meeting of that day gone from a calendar that
  // answered, with no note, is dropped: it was cancelled or moved.
  sync(input: MeetingSync): Meeting[] {
    this.db.transaction(() => {
      const kept = input.events.map(
        (e) =>
          this.db
            .query<Row, (string | number | null)[]>(
              `INSERT INTO meetings (source, event_key, occurrence, title, starts_at, ends_at, all_day)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (source, event_key, occurrence) DO UPDATE SET
               title = excluded.title, starts_at = excluded.starts_at,
               ends_at = excluded.ends_at, all_day = excluded.all_day
             RETURNING ${COLUMNS}`,
            )
            .get(
              e.source,
              e.eventKey,
              e.occurrence ?? "",
              e.title,
              instant(e.start),
              instant(e.end),
              e.allDay ? 1 : 0,
            ) as Row,
      );
      const ids = JSON.stringify(kept.map((r) => r.id));
      for (const source of input.sources)
        this.db.run(
          `DELETE FROM meetings WHERE source = ? AND starts_at >= ? AND starts_at < ?
             AND note_id IS NULL AND id NOT IN (SELECT value FROM json_each(?))`,
          [source, input.from, input.to, ids],
        );
    })();
    this.listeners.notify();
    return this.db
      .query<Row, [string, string]>(
        `SELECT ${COLUMNS} FROM meetings WHERE starts_at >= ? AND starts_at < ? ORDER BY starts_at`,
      )
      .all(input.from, input.to)
      .map(meetingOf);
  }

  // Meetings started before `before` (today's midnight) and never closed: the carry-over.
  open(before: string): Meeting[] {
    return this.db
      .query<Row, [string]>(
        `SELECT ${COLUMNS} FROM meetings WHERE closed_at IS NULL AND starts_at < ?
         ORDER BY starts_at`,
      )
      .all(before)
      .map((r) => meetingOf(r));
  }

  get(id: number): Meeting {
    const row = this.db
      .query<Row, [number]>(`SELECT ${COLUMNS} FROM meetings WHERE id = ?`)
      .get(id);
    if (!row) throw new MeetingError(`no meeting ${id}`);
    return meetingOf(row);
  }

  // Links the meeting to its note (a memory doc id).
  setNote(id: number, noteId: string): Meeting {
    return this.set(id, "note_id = ?", [noteId]);
  }

  close(id: number): Meeting {
    return this.set(id, "closed_at = coalesce(closed_at, ?)", [new Date().toISOString()]);
  }

  reopen(id: number): Meeting {
    return this.set(id, "closed_at = NULL", []);
  }

  // «Cerrar las de días anteriores»: every open meeting started before `before`, note or not.
  closeBefore(before: string): number {
    const n = this.db.run(
      "UPDATE meetings SET closed_at = ? WHERE closed_at IS NULL AND starts_at < ?",
      [new Date().toISOString(), before],
    ).changes;
    if (n > 0) this.listeners.notify();
    return n;
  }

  private set(id: number, sql: string, values: string[]): Meeting {
    const row = this.db
      .query<Row, (string | number)[]>(
        `UPDATE meetings SET ${sql} WHERE id = ? RETURNING ${COLUMNS}`,
      )
      .get(...values, id);
    if (!row) throw new MeetingError(`no meeting ${id}`);
    this.listeners.notify();
    return meetingOf(row);
  }
}
