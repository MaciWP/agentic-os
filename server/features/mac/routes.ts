import { Hono } from "hono";
import { cached, cachedBy } from "../../cache.ts";
import type { Config } from "../../config.ts";
import { fileCopy } from "../../json-file.ts";
import { parseDay } from "../google/client.ts";
import {
  MAIL_ID,
  type OpenSettings,
  OutlookCopy,
  outlookClient,
  type StartMail,
} from "./outlook.ts";
import { type MacRunner, runMac } from "./run.ts";

const TTL_MS = 60_000;

// The Outlook reads the routes and the mail categorizer share, so a proposal is checked against
// the same inbox and folders the agent read. Today's agenda and the inbox answer at once and
// say through `onChange` when they changed. With `copyPath`, the inbox is kept on disk too, so
// a restarted server answers it at once.
export function macReads(
  run: MacRunner = runMac,
  start: StartMail | null = null,
  onChange?: () => void,
  copyPath?: string,
) {
  const client = outlookClient(run, {
    start,
    copy: copyPath ? fileCopy(copyPath, OutlookCopy) : null,
  });
  return {
    client,
    agenda: cached(() => client.agenda(), { ttlMs: TTL_MS, onChange }),
    // Another day's agenda: one read per day per minute, however fast the days are paged.
    agendaOn: cachedBy<Awaited<ReturnType<typeof client.agenda>>>({ ttlMs: TTL_MS }),
    inbox: cached(() => client.inbox(), { ttlMs: TTL_MS, onChange, initial: client.storedInbox() }),
    // ~8 s over every folder: what the categorizer learns from, kept for a while.
    folders: cached(() => client.folders(), { ttlMs: 30 * 60_000 }),
  };
}
export type MacReads = ReturnType<typeof macReads>;

// Outlook through the Mac (Exchange in Internet Accounts), read by AgenticMac.app.
// `openSettings`: only the app passes the real one, so no test opens System Settings.
export function macRoutes(
  { config }: { config: Config },
  reads: MacReads = macReads(),
  openSettings: OpenSettings | null = null,
) {
  const { client, agenda, agendaOn, inbox, folders } = reads;
  const off = () => ({ disabled: true as const });
  const fresh = (q: string | undefined) => ({ fresh: q === "1" });

  return (
    new Hono()
      .get("/outlook/agenda", async (c) => {
        if (!config.providers.outlook) return c.json(off());
        const day = c.req.query("day");
        if (day === undefined)
          return c.json({ events: await agenda.get(fresh(c.req.query("fresh"))) });
        const at = parseDay(day);
        if (!at) return c.json({ error: "invalid_day", detail: "day is YYYY-MM-DD" }, 400);
        return c.json({ events: await agendaOn.of(day, () => client.agenda(at)).get() });
      })
      .get("/outlook/inbox", async (c) =>
        config.providers.outlook
          ? c.json(await inbox.get(fresh(c.req.query("fresh"))))
          : c.json(off()),
      )
      .get("/outlook/folders", async (c) =>
        config.providers.outlook
          ? c.json(await folders.get(fresh(c.req.query("fresh"))))
          : c.json(off()),
      )
      // «Dar permiso»: macOS asks for Calendars; when it does not (an app it already decided on),
      // the Calendars list opens for the user to tick AgenticMac. Desktop only: it is the Mac's
      // screen that shows either.
      .post("/outlook/grant", async (c) => {
        if (!config.providers.outlook) return c.json(off());
        const calendar = await client.grant();
        const settings = calendar !== "granted" && openSettings !== null && (await openSettings());
        agenda.invalidate();
        agendaOn.invalidate();
        return c.json({ calendar, settings });
      })
      .get("/outlook/messages/:id", async (c) => {
        const id = c.req.param("id");
        if (!MAIL_ID.test(id))
          return c.json({ error: "invalid_mail", detail: "id is digits" }, 400);
        return config.providers.outlook ? c.json(await client.message(id)) : c.json(off());
      })
  );
}
