import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject terminal controls in display text.
const forbiddenDisplay = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !forbiddenDisplay.test(s), "Invalid display text");
export const WorkTicket = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
  .max(100);
export const WorkDecision = z.object({
  id,
  question: text(1500),
  options: z.array(text(150)).max(6),
  blocking: z.boolean(),
  revision: z.number().int().positive(),
  state: z.enum(["pending", "queued", "delivered", "failed", "cancelled"]),
  response: text(2000).optional(),
  error: text(1000).optional(),
  requestId: id.optional(),
});
export const WorkSession = z
  .object({
    version: z.literal(1),
    sessionId: id,
    cwd: text(4096),
    ticket: WorkTicket.nullable(),
    tasks: z
      .array(
        z.object({
          id,
          title: text(500),
          state: z.enum(["pending", "running", "blocked", "completed", "failed"]),
          dependsOn: z.array(id).max(100).optional(),
        }),
      )
      .max(100),
    decisions: z.array(WorkDecision).max(30),
    checks: z
      .array(
        z.object({
          id: text(200),
          title: text(500),
          state: text(30),
          at: z.number().nonnegative(),
          source: text(100),
          revision: text(100).optional(),
        }),
      )
      .max(30),
    agents: z.array(z.object({ id, title: text(500), state: text(30) })).max(100),
    working: z.boolean(),
    robin: z.object({ text: text(4000), at: z.number().nonnegative() }).nullable(),
    failure: z.object({ text: text(2000), at: z.number().nonnegative() }).nullable(),
  })
  .refine(
    (s) =>
      [s.tasks, s.decisions, s.agents].every(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      ),
    "Duplicate identifiers",
  );
export const WorkResponse = z.object({
  sessionId: id,
  decisionId: id,
  revision: z.number().int().positive(),
  response: text(2000),
  requestId: id,
});
export const WorkAck = z.object({
  sessionId: id,
  decisionId: id,
  revision: z.number().int().positive(),
  requestId: id,
  delivered: z.boolean(),
  error: text(1000).optional(),
});
export const StoredWorkSession = WorkSession.safeExtend({
  actor: id,
  updatedAt: z.number().nonnegative(),
});
export type WorkSession = z.infer<typeof WorkSession>;
export type StoredWorkSession = z.infer<typeof StoredWorkSession>;
export type WorkResponse = z.infer<typeof WorkResponse>;
export type WorkAck = z.infer<typeof WorkAck>;
