import { z } from "zod";
import { OutlookInbox } from "../../../shared/mail-inbox.ts";
import type { FileCopy } from "../../json-file.ts";
import { run as exec } from "../../run.ts";
import { type AgendaEvent, dayWindow } from "../google/client.ts";
import { MacError, type MacRunner } from "./run.ts";

// Outlook as the Mac syncs it: what AgenticMac prints, checked here before anything uses it.

const Events = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      occurrence: z.string(),
      title: z.string().nullable(),
      start: z.string(),
      end: z.string(),
      allDay: z.boolean(),
      location: z.string().nullable(),
      meet: z.string().nullable(),
      attendees: z.array(z.string()),
    }),
  ),
});

// A hash of the inbox's ids, read and flag marks: `inbox` prints something new only when it changes.
const Stamp = z.object({ hash: z.string().min(1) });

// The inbox as last read with its stamp, kept on disk (`copy`): a restarted server answers it
// at once and reads the whole inbox again only when the stamp moved.
export const OutlookCopy = z.object({ hash: z.string(), inbox: OutlookInbox });
export type OutlookCopy = z.infer<typeof OutlookCopy>;

const Message = z.object({
  id: z.string(),
  messageId: z.string(),
  subject: z.string().nullable(),
  from: z.string(),
  at: z.string(),
  body: z.string(),
  truncated: z.boolean(),
  to: z.string().nullable(),
  cc: z.string().nullable(),
});
export type OutlookMessage = z.infer<typeof Message>;

const Folders = z.object({
  folders: z.array(
    z.object({
      path: z.string(),
      role: z.enum(["inbox", "trash", "junk", "sent", "drafts"]).nullable(),
      total: z.number().int(),
      senders: z.array(z.object({ from: z.string(), count: z.number().int() })),
    }),
  ),
});
export type OutlookFolders = z.infer<typeof Folders>;

// A batch for `apply` and `confirm`, read by the helper as data. `messageId`: Outlook's RFC
// Message-ID for `apply`; for `confirm`, whatever id the account uses (a Gmail thread).
export type MacBatchItem = { messageId: string; op: "move" | "trash"; folder: string };

const Applied = z.object({
  results: z.array(
    z.object({
      messageId: z.string(),
      result: z.string(),
    }),
  ),
});
const Confirmed = z.object({ confirmed: z.literal(true) });
const Granted = z.object({ calendar: z.enum(["granted", "denied"]), mail: z.string() });

// Over the helper's own 120 s, which also counts the time its dialog waits for the click.
const ASK_MS = 130_000;
// How long «Dar permiso» waits for macOS's prompt to be answered. A prompt that never shows
// (an app macOS stopped asking about) would otherwise hold the page for the helper's 120 s.
const GRANT_MS = 30_000;

export const MAIL_ID = /^\d{1,10}$/;

function parsed<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new MacError("script", "the helper's data changed shape");
  return result.data;
}

export function toOutlookEvents(raw: z.infer<typeof Events>): AgendaEvent[] {
  return raw.events.map((e) => ({
    source: "outlook",
    id: e.id,
    occurrence: e.occurrence,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location,
    meet: e.meet,
    link: null,
    attendees: e.attendees,
  }));
}

// Mail answers only while it runs. Closed, it is opened hidden: no window, no focus.
export type StartMail = () => Promise<void>;
export const startMail: StartMail = async () => {
  await exec(["open", "-g", "-j", "-b", "com.apple.mail"], { timeoutMs: 10_000 });
};
const MAIL_RETRIES = 6;

// The Calendars list in Privacy & Security, where AgenticMac is ticked when macOS does not ask.
export type OpenSettings = () => Promise<boolean>;
export const openCalendarSettings: OpenSettings = async () => {
  const pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars";
  return (await exec(["open", pane], { timeoutMs: 10_000 })).code === 0;
};

// Deadlines a little over the helper's own (15 s, 60 s for folders), so its reason wins.
// With `start`, a read that finds Mail closed opens it once and retries while it starts (the
// user's call, 2026-10-22); without it the read stays "mail_closed".
export function outlookClient(
  run: MacRunner,
  {
    start = null,
    pauseMs = 1500,
    copy = null,
  }: { start?: StartMail | null; pauseMs?: number; copy?: FileCopy<OutlookCopy> | null } = {},
) {
  const withMail = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let tries = 0; ; tries++) {
      try {
        return await read();
      } catch (err) {
        const closed = err instanceof MacError && err.code === "mail_closed";
        if (!start || !closed || tries === MAIL_RETRIES) throw err;
        if (tries === 0) await start();
        else await Bun.sleep(pauseMs);
      }
    }
  };
  const stored = copy?.read();
  let last = stored?.value;
  return {
    async agenda(now = new Date()): Promise<AgendaEvent[]> {
      // The helper's ISO parser takes no milliseconds.
      const { timeMin, timeMax } = dayWindow(now);
      const bare = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");
      const raw = await run(["events", bare(timeMin), bare(timeMax)], 20_000);
      return toOutlookEvents(parsed(Events, raw));
    },
    // The stamp first; the whole inbox only when it moved. A helper built before `stamp`
    // existed answers bad_input: then every read is a whole one, as before.
    async inbox(): Promise<OutlookInbox> {
      let hash = "";
      try {
        hash = parsed(Stamp, await withMail(() => run(["stamp"], 20_000))).hash;
      } catch (err) {
        if (!(err instanceof MacError && err.code === "bad_input")) throw err;
      }
      if (hash && last?.hash === hash) return last.inbox;
      const inbox = parsed(OutlookInbox, await withMail(() => run(["inbox"], 20_000)));
      last = hash ? { hash, inbox } : undefined;
      if (last) copy?.write(last);
      return inbox;
    },
    // The stored inbox: what a restarted server answers first.
    storedInbox: () => stored && { at: stored.at, value: stored.value.inbox },
    async message(id: string): Promise<OutlookMessage> {
      if (!MAIL_ID.test(id)) throw new MacError("bad_input", "a mail id is digits");
      return parsed(Message, await withMail(() => run(["message", id], 20_000)));
    },
    async folders(): Promise<OutlookFolders> {
      return parsed(Folders, await withMail(() => run(["folders"], 65_000)));
    },
    // Moves inbox mail after the user confirms the batch in a native dialog: one result per
    // mail ("ok", "not_found", "no_folder", "error <n>"). A cancel is MacError "cancelled".
    async apply(batch: MacBatchItem[]) {
      return parsed(Applied, await withMail(() => run(["apply"], ASK_MS, batch))).results;
    },
    // macOS's Calendars prompt, asked in the foreground because the user pressed for it. No
    // answer in GRANT_MS is "unanswered"; the helper keeps the prompt up until its own deadline.
    async grant(): Promise<"granted" | "denied" | "unanswered"> {
      try {
        return parsed(Granted, await run(["grant"], GRANT_MS)).calendar;
      } catch (err) {
        if (err instanceof MacError && err.code === "timeout") return "unanswered";
        throw err;
      }
    },
    // The same dialog for another account's batch (Gmail); it changes no mail itself.
    async confirm(batch: MacBatchItem[]): Promise<void> {
      parsed(Confirmed, await run(["confirm"], ASK_MS, batch));
    },
  };
}
