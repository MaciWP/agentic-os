import { z } from "zod";
import { EffortSchema } from "./harness-capabilities.ts";

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (s) =>
        !Array.from(s).some(
          (c) => (c.charCodeAt(0) < 32 && !"\n\r\t".includes(c)) || c.charCodeAt(0) === 127,
        ) && new TextEncoder().encode(s).length <= max,
      "text too long or contains control characters",
    );
export const AgentHarness = z.enum(["claude", "codex", "grok"]);
export const Participant = z.object({
  harness: AgentHarness,
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/),
  effort: EffortSchema.optional(),
});
export type Participant = z.infer<typeof Participant>;
// An agent here, or `agent@machine` for one on another machine (server/features/coordination/remote.ts).
const address = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[A-Za-z0-9_-]+(?:@[a-z][a-z0-9-]{0,31})?$/);
export const MessageInput = z.object({
  requestId: id,
  to: address,
  text: text(12 * 1024),
  replyTo: id.optional(),
});
export const MessageRecord = MessageInput.extend({
  id,
  from: address,
  threadId: id,
  createdAt: z.string(),
  status: z.enum(["pending", "delivering", "delivered", "answered", "failed", "uncertain"]),
  error: z.string().nullable(),
});
export type CoordMessage = z.infer<typeof MessageRecord>;
export const Reservation = z.object({
  id,
  owner: id,
  generation: z.string(),
  root: z.string(),
  path: z.string(),
  reason: z.string(),
  status: z.enum(["active", "orphaned"]),
  createdAt: z.string(),
});
export type Reservation = z.infer<typeof Reservation>;
export const ReserveInput = z.object({
  location: z.string().min(1).max(200),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
  reason: text(500),
});
export const ContextRef = z.object({
  ticket: z
    .string()
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
    .optional(),
  pr: z
    .object({ repo: z.string().min(1).max(100), number: z.number().int().positive() })
    .optional(),
});
export const ConsultationInput = z.object({
  requestId: id,
  location: z.string().min(1).max(200),
  prompt: text(12 * 1024),
  context: z
    .string()
    .max(32 * 1024)
    .default(""),
  refs: ContextRef.optional(),
  participants: z
    .array(Participant)
    .min(2)
    .max(3)
    .refine(
      (p) => new Set(p.map((x) => x.harness)).size === p.length,
      "one participant per harness",
    ),
  timeoutMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
});
export const Attempt = z.object({
  id,
  participant: Participant,
  kind: z.enum(["opinion", "synthesis"]),
  state: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ]),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
});
export type Attempt = z.infer<typeof Attempt>;
export const ReservationAudit = z.object({
  actor: id,
  owner: id,
  path: z.string(),
  action: z.literal("release"),
  at: z.string(),
});
export const Consultation = z.object({
  id,
  author: id,
  input: ConsultationInput,
  contextText: z.string(),
  createdAt: z.string(),
  state: z.enum(["preparing", "pending", "approved", "running", "finished", "cancelled", "failed"]),
  approvedAt: z.string().nullable(),
  fingerprint: z.string().nullable(),
  snapshot: z.string().nullable(),
  snapshotInfo: z
    .object({
      head: z.string(),
      files: z.number().int(),
      bytes: z.number().int(),
      excluded: z.array(z.string()),
    })
    .nullable()
    .default(null),
  source: z.string(),
  error: z.string().nullable(),
  attempts: z.array(Attempt),
});
export type Consultation = z.infer<typeof Consultation>;
export type ConsultationControl = {
  start(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
};
