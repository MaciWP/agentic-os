import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ModelSchema } from "../../../shared/harness-capabilities.ts";
import { EffortSchema, HarnessSchema } from "./harness.ts";

// A crash-loop guard, not a lifetime limit: a session is resumed on its own at most this many
// times in a row, so a host that keeps dying cannot relaunch it forever. One that ran for
// STABLE_MS before it was lost starts counting again.
export const MAX_RESUMES = 3;
export const STABLE_MS = 10 * 60_000;

export type LostTerminal = {
  id: string;
  harness: string;
  location: string;
  ticket: string | null;
  sessionId: string | null;
  name: string | null;
  model: string | null;
  effort: string | null;
  resumes: number;
};

const LOST_COLUMNS =
  "id, harness, location, ticket, session_id AS sessionId, name, model, effort, resumes";

// PTYs die with the process that owns them. Only that process (the PTY host) calls this,
// at its start: whatever was still running before it is lost. Returns what it marked.
export function markLost(db: Database): LostTerminal[] {
  return db
    .query<LostTerminal, [string, number]>(
      `UPDATE terminal_sessions SET state = 'lost', ended_at = ?1,
         resumes = CASE WHEN (julianday(?1) - julianday(started_at)) * 86400000 >= ?2
                   THEN 0 ELSE resumes END
       WHERE state = 'running'
       RETURNING ${LOST_COLUMNS}`,
    )
    .all(new Date().toISOString(), STABLE_MS);
}

// One row in a given state: lost for a manual resume, running for a restart.
export function lostRow(
  db: Database,
  id: string,
  state: "lost" | "running" | "exited" = "lost",
): LostTerminal | null {
  return db
    .query<LostTerminal, [string, string]>(
      `SELECT ${LOST_COLUMNS} FROM terminal_sessions WHERE id = ? AND state = ?`,
    )
    .get(id, state);
}

// Whether «Reanudar» can bring a lost row back: an agent with a session, or a Codex.
export const canResume = (row: LostTerminal) => ResumeRow.safeParse({ ...row, resumes: 0 }).success;

// What may be resumed of a lost row: an agent with its session id, under the resume cap. A
// Codex without one comes back on its session picker. The row is read back from the
// database, so every field is checked again.
export const ResumeRow = z
  .object({
    id: z.string().min(1),
    harness: HarnessSchema.exclude(["shell"]),
    location: z.string().min(1),
    ticket: z.string().nullable(),
    sessionId: z.string().min(1).nullable(),
    name: z.string().nullable(),
    model: ModelSchema.nullable().catch(null),
    effort: EffortSchema.nullable().catch(null),
    resumes: z
      .number()
      .int()
      .max(MAX_RESUMES - 1),
  })
  .refine((r) => r.sessionId !== null || r.harness === "codex");
