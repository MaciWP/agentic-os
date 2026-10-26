import { z } from "zod";

// A meeting on «Hoy» (server/features/meetings): seen in a calendar, kept until closed.
export const Meeting = z.object({
  id: z.number().int(),
  source: z.enum(["google", "outlook"]),
  eventKey: z.string(),
  occurrence: z.string().nullable(),
  title: z.string().nullable(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  noteId: z.string().nullable(),
  closedAt: z.string().nullable(),
});
export type Meeting = z.infer<typeof Meeting>;

// What the browser read from the calendars for one local day [from, to). `sources` names the
// calendars that answered: a meeting gone from one of them was cancelled or moved, while one
// whose calendar failed is kept as it was.
export const MeetingSync = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  sources: z.array(z.enum(["google", "outlook"])).max(2),
  events: z
    .array(
      z.strictObject({
        source: z.enum(["google", "outlook"]),
        eventKey: z.string().min(1).max(1024),
        occurrence: z.string().max(64).nullable(),
        title: z.string().max(1024).nullable(),
        start: z.string().min(1).max(40),
        end: z.string().min(1).max(40),
        allDay: z.boolean(),
      }),
    )
    .max(300),
});
export type MeetingSync = z.infer<typeof MeetingSync>;

export const MeetingsBefore = z.strictObject({ before: z.iso.datetime() });

// What the calendar said about who attends, for the note's first section. The meeting row keeps
// no attendees: they come from the browser's last read of the event.
export const MeetingNote = z.strictObject({
  attendees: z.array(z.string().trim().min(1).max(200)).max(200),
});
