import { z } from "zod";
import { ModelSchema } from "../../../shared/harness-capabilities.ts";
import {
  DiffNote,
  IMAGE_ID,
  MAX_BRING_IMAGES,
  MAX_BRING_NOTES,
  TERMINAL_KEY_NAMES,
} from "../../../shared/terminals.ts";
import { ISSUE_KEY } from "../jira/client.ts";
import { Message } from "./contract.ts";
import { EffortSchema, HarnessSchema, MAX_PROMPT_BYTES } from "./harness.ts";

// A PR: the repo id from config and its number, never a URL or a path.
export const PrRef = z.object({
  repo: z.string().min(1).max(100),
  number: z.number().int().positive(),
});
export const CreateBody = z.object({
  requestId: z.string().uuid().optional(),
  harness: HarnessSchema,
  location: z.string().min(1).max(200),
  ticket: z.string().regex(ISSUE_KEY).optional(),
  review: PrRef.optional(),
  // The id of a document in the saved prompts folder.
  savedPrompt: z.string().min(1).max(1024).optional(),
  // From `aos` only: a prompt of the caller's own. The page never sends one.
  prompt: z.string().min(1).max(MAX_PROMPT_BYTES).optional(),
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});
export const SendBody = z
  .object({
    text: z
      .string()
      .min(1)
      .refine((t) => Buffer.byteLength(t) <= MAX_PROMPT_BYTES, "text too long")
      .refine((t) => !t.includes("\0"), "text must not contain NUL")
      .optional(),
    // Named keys, written bare after the text: a phone answers a menu without attaching.
    keys: z.array(z.enum(TERMINAL_KEY_NAMES)).min(1).max(16).optional(),
    enter: z.boolean().optional(),
    interrupt: z.boolean().optional(),
  })
  .refine((b) => b.text !== undefined || b.keys || b.enter || b.interrupt, "nothing to send");
// «Copiar contexto», from the query string: a ticket key, or a PR as its repo and number.
export const ContextQuery = z.union([
  z.strictObject({ ticket: z.string().regex(ISSUE_KEY) }),
  z.strictObject({ repo: PrRef.shape.repo, number: z.coerce.number().int().positive() }),
]);
// What "Llevar a terminal" types: a ticket or a PR, built here like a launch prompt, the
// paths of images in the history (a pasted one goes there first, through /api/images), or
// notes on a diff.
export const BringBody = z.union([
  // Without a task, an agent gets the item's content and no instruction.
  z.strictObject({
    ticket: z.string().regex(ISSUE_KEY),
    task: z.enum(["work", "review"]).optional(),
  }),
  z.strictObject({ pr: PrRef, task: z.literal("review").optional() }),
  z.strictObject({
    images: z.array(z.string().max(1024).regex(IMAGE_ID)).min(1).max(MAX_BRING_IMAGES),
  }),
  // Review notes from a diff, for an agent only.
  z.strictObject({ notes: z.array(DiffNote).min(1).max(MAX_BRING_NOTES) }),
  // A saved prompt of the work bar, filled with the terminal's context and sent with Enter.
  z.strictObject({ prompt: z.string().min(1).max(1024) }),
]);
export const Auth = z.object({
  type: z.literal("auth"),
  token: z.string().min(1).max(128),
  // Displace the window holding the terminal: only an explicit open (a popout, "Traer aquí").
  take: z.boolean().default(false),
});
// A browser cannot see protocol pings, so a window asks with its own and takes any frame back
// as proof the path is alive (window.tsx: on waking and as a heartbeat). Kept here, not in
// contract.ts: the PTY host imports that one, and this needs no host restart.
export const Inbound = z.union([Message, z.object({ type: z.literal("ping") })]);
