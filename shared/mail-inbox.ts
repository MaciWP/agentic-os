import { z } from "zod";

// The two inboxes Inicio shows, as the server answers them. One schema each checks what the
// helper prints, the copy the server keeps on disk and the copy a browser keeps.

// Gmail (server/features/google/client.ts): the newest inbox threads.
export const MailThread = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  from: z.string(),
  at: z.string(),
  snippet: z.string(),
  messages: z.number().int(),
  unread: z.boolean(),
  starred: z.boolean(),
  link: z.string(),
});
export type MailThread = z.infer<typeof MailThread>;

export const MailInbox = z.object({ threads: z.array(MailThread), total: z.number().int() });
export type MailInbox = z.infer<typeof MailInbox>;

// Outlook through the Mac (server/features/mac/outlook.ts), as AgenticMac prints it.
const OutlookMail = z.object({
  // Mail.app's id: local to this Mac and to the folder, so it changes when the mail moves.
  id: z.string().regex(/^\d+$/),
  // The RFC Message-ID: what a task keeps to find the mail again.
  messageId: z.string(),
  subject: z.string().nullable(),
  from: z.string(),
  at: z.string(),
  unread: z.boolean(),
  flagged: z.boolean(),
});

export const OutlookInbox = z.object({ total: z.number().int(), messages: z.array(OutlookMail) });
export type OutlookInbox = z.infer<typeof OutlookInbox>;
