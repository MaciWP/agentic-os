import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type Status, type Track, Turn, Words } from "./contracts.ts";

export class TranscriptError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Row = {
  id: string;
  meeting_id: number | null;
  dir: string;
  status: Status;
  speakers: number | null;
  speaker_names: string;
  diarization: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
export type Recording = {
  id: string;
  meetingId: number | null;
  dir: string;
  status: Status;
  speakers: number | null;
  names: Record<string, string>;
  turns: Turn[] | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
const COLUMNS =
  "id, meeting_id, dir, status, speakers, speaker_names, diarization, error, created_at, updated_at";

const Names = z.record(z.string(), z.string());
const WordList = z.array(Words);
const TurnList = z.array(Turn);

const recordingOf = (r: Row): Recording => ({
  id: r.id,
  meetingId: r.meeting_id,
  dir: r.dir,
  status: r.status,
  speakers: r.speakers,
  names: Names.parse(JSON.parse(r.speaker_names)),
  turns: r.diarization === null ? null : TurnList.parse(JSON.parse(r.diarization)),
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type ChunkRow = { track: Track; idx: number; offset: number; duration: number };

// The recordings and what each chunk of them has become. The audio stays on disk; a row here
// is how a restart knows what is left to do.
export class TranscriptStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: { id: string; dir: string; meetingId?: number; speakers?: number }): Recording {
    if (
      input.meetingId !== undefined &&
      !this.db.query("SELECT 1 FROM meetings WHERE id = ?").get(input.meetingId)
    )
      throw new TranscriptError(404, "not_found", "meeting not found");
    const at = this.now().toISOString();
    return recordingOf(
      this.db
        .query<Row, (string | number | null)[]>(
          `INSERT INTO recordings (id, meeting_id, dir, status, speakers, created_at, updated_at)
           VALUES (?, ?, ?, 'recording', ?, ?, ?) RETURNING ${COLUMNS}`,
        )
        .get(input.id, input.meetingId ?? null, input.dir, input.speakers ?? null, at, at) as Row,
    );
  }

  find(id: string): Recording | null {
    const row = this.db
      .query<Row, [string]>(`SELECT ${COLUMNS} FROM recordings WHERE id = ?`)
      .get(id);
    return row ? recordingOf(row) : null;
  }

  get(id: string): Recording {
    const found = this.find(id);
    if (!found) throw new TranscriptError(404, "not_found", "recording not found");
    return found;
  }

  list(): Recording[] {
    return this.db
      .query<Row, []>(`SELECT ${COLUMNS} FROM recordings ORDER BY created_at DESC`)
      .all()
      .map(recordingOf);
  }

  unfinished(): Recording[] {
    return this.db
      .query<Row, []>(
        `SELECT ${COLUMNS} FROM recordings WHERE status NOT IN ('ready', 'failed') ORDER BY created_at`,
      )
      .all()
      .map(recordingOf);
  }

  setStatus(id: string, status: Status, error: string | null = null) {
    this.db
      .query("UPDATE recordings SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error, this.now().toISOString(), id);
  }

  setTurns(id: string, turns: Turn[]) {
    this.db
      .query("UPDATE recordings SET diarization = ? WHERE id = ?")
      .run(JSON.stringify(turns), id);
  }

  // The calendar meeting a recording made at `at` belongs to: one not all day, started at most
  // 10 minutes later and not yet over, the nearest start first. A recording with none is linked
  // when a later sync brings it (Inicio is what reads the calendars).
  linkMeetings() {
    this.db.run(
      `UPDATE recordings SET meeting_id = (
         SELECT m.id FROM meetings m
         WHERE m.all_day = 0
           AND m.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ', recordings.created_at, '+10 minutes')
           AND m.ends_at >= recordings.created_at
         ORDER BY abs(julianday(m.starts_at) - julianday(recordings.created_at)) LIMIT 1)
       WHERE meeting_id IS NULL AND created_at >= ?`,
      [new Date(this.now().getTime() - 86_400_000).toISOString()],
    );
  }

  setNames(id: string, names: Record<string, string>) {
    this.get(id);
    // An empty name takes the label back to its default.
    const kept = Object.fromEntries(Object.entries(names).filter(([, v]) => v.trim() !== ""));
    this.db
      .query("UPDATE recordings SET speaker_names = ? WHERE id = ?")
      .run(JSON.stringify(kept), id);
  }

  addChunks(id: string, chunks: ChunkRow[]) {
    const insert = this.db.query(
      `INSERT OR IGNORE INTO recording_chunks (recording_id, track, idx, offset_sec, duration_sec)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const c of chunks) insert.run(id, c.track, c.idx, c.offset, c.duration);
    })();
  }

  pending(id: string): ChunkRow[] {
    return this.db
      .query<{ track: Track; idx: number; offset_sec: number; duration_sec: number }, [string]>(
        `SELECT track, idx, offset_sec, duration_sec FROM recording_chunks
         WHERE recording_id = ? AND status = 'pending' ORDER BY track DESC, idx`,
      )
      .all(id)
      .map((r) => ({ track: r.track, idx: r.idx, offset: r.offset_sec, duration: r.duration_sec }));
  }

  markDone(id: string, track: Track, idx: number, words: Words[]) {
    this.db
      .query(
        `UPDATE recording_chunks SET status = 'done', text = ?
         WHERE recording_id = ? AND track = ? AND idx = ?`,
      )
      .run(JSON.stringify(words), id, track, idx);
  }

  // Chunks transcribed out of those closed so far, both tracks.
  progress(id: string): { done: number; total: number } {
    return (
      this.db
        .query<{ done: number; total: number }, [string]>(
          `SELECT COALESCE(SUM(status = 'done'), 0) AS done, COUNT(*) AS total
           FROM recording_chunks WHERE recording_id = ?`,
        )
        .get(id) ?? { done: 0, total: 0 }
    );
  }

  chunkCount(id: string, track: Track): number {
    return (
      this.db
        .query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) AS n FROM recording_chunks WHERE recording_id = ? AND track = ?",
        )
        .get(id, track)?.n ?? 0
    );
  }

  // Seconds recorded so far: where the last closed chunk of either track ends.
  length(id: string): number {
    return (
      this.db
        .query<{ s: number }, [string]>(
          `SELECT COALESCE(MAX(offset_sec + duration_sec), 0) AS s
           FROM recording_chunks WHERE recording_id = ?`,
        )
        .get(id)?.s ?? 0
    );
  }

  words(id: string, track: Track): Words[] {
    return this.db
      .query<{ text: string }, [string, string]>(
        `SELECT text FROM recording_chunks
         WHERE recording_id = ? AND track = ? AND status = 'done' ORDER BY idx`,
      )
      .all(id, track)
      .flatMap((r) => WordList.parse(JSON.parse(r.text)));
  }
}
