import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { ConfigSchema } from "../../config.ts";
import { errorHandler } from "../../errors.ts";
import { fileCopy } from "../../json-file.ts";
import { OutlookCopy, outlookClient } from "./outlook.ts";
import { macReads, macRoutes } from "./routes.ts";
import { MacError, type MacRunner, parseEnvelope } from "./run.ts";

const ok = (data: unknown) => JSON.stringify({ ok: true, data });

describe("parseEnvelope", () => {
  test("returns the data of an ok answer", () => {
    expect(parseEnvelope(ok({ events: [] }))).toEqual({ events: [] });
  });

  test("turns the helper's reason into a MacError with its status", () => {
    const err = (() => {
      try {
        parseEnvelope(JSON.stringify({ ok: false, reason: "mail_closed" }));
      } catch (e) {
        return e;
      }
    })() as MacError;
    expect(err).toBeInstanceOf(MacError);
    expect([err.code, err.status]).toEqual(["mail_closed", 503]);
  });

  test("an unknown reason, no JSON or a changed shape is a script error", () => {
    for (const text of [JSON.stringify({ ok: false, reason: "weird" }), "", '{"ok":1}'])
      expect(() => parseEnvelope(text)).toThrow(MacError);
  });
});

const event = {
  id: "EXT-1",
  occurrence: "2026-01-05T09:00:00Z",
  title: "Daily",
  start: "2026-01-05T09:00:00Z",
  end: "2026-01-05T09:15:00Z",
  allDay: false,
  location: null,
  meet: null,
  attendees: ["Ana", "Luis"],
};
const mail = {
  id: "42",
  messageId: "abc@example.test",
  subject: "Hola",
  from: "Ana <ana@example.test>",
  at: "2026-01-05T08:00:00Z",
  unread: true,
  flagged: false,
};

function fake(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const run: MacRunner = async (args) => {
    calls.push(args);
    const answer = answers[args[0] as string];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

describe("outlookClient", () => {
  test("reads the local day and marks each event as Outlook's, with no web link", async () => {
    const { run, calls } = fake({ events: { events: [event] } });
    const events = await outlookClient(run).agenda(new Date(2026, 0, 5, 12));
    expect(events).toEqual([{ ...event, source: "outlook", link: null }]);
    expect(calls[0]?.[0]).toBe("events");
    expect(new Date(calls[0]?.[1] as string).getDate()).toBe(5);
    // AgenticMac's ISO8601DateFormatter rejects fractional seconds.
    expect(calls[0]?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("a changed shape is an error, never a partial list", async () => {
    const { run } = fake({
      stamp: { hash: "h1" },
      inbox: { total: 1, messages: [{ ...mail, id: "x" }] },
    });
    await expect(outlookClient(run).inbox()).rejects.toBeInstanceOf(MacError);
  });

  test("a closed Mail is opened once, hidden, and the read retried while it starts", async () => {
    let closed = 2;
    const run: MacRunner = async (args) => {
      if (closed-- > 0) throw new MacError("mail_closed");
      return args[0] === "stamp" ? { hash: "h1" } : { total: 1, messages: [mail] };
    };
    let opened = 0;
    const inbox = await outlookClient(run, {
      start: async () => void opened++,
      pauseMs: 0,
    }).inbox();
    expect([inbox.total, opened]).toEqual([1, 1]);
    const never: MacRunner = async () => {
      throw new MacError("mail_closed");
    };
    await expect(
      outlookClient(never, { start: async () => {}, pauseMs: 0 }).inbox(),
    ).rejects.toMatchObject({ code: "mail_closed" });
  });

  test("the whole inbox is read again only when its stamp moved", async () => {
    const answers: Record<string, unknown> = {
      stamp: { hash: "h1" },
      inbox: { total: 1, messages: [mail] },
    };
    const { run, calls } = fake(answers);
    const client = outlookClient(run);
    await client.inbox();
    await client.inbox();
    expect(calls.map((c) => c[0])).toEqual(["stamp", "inbox", "stamp"]);
    answers.stamp = { hash: "h2" };
    await client.inbox();
    expect(calls.map((c) => c[0])).toEqual(["stamp", "inbox", "stamp", "stamp", "inbox"]);
  });

  test("a helper without stamp reads the whole inbox every time", async () => {
    const { run, calls } = fake({
      stamp: new MacError("bad_input"),
      inbox: { total: 1, messages: [mail] },
    });
    const client = outlookClient(run);
    expect((await client.inbox()).total).toBe(1);
    expect((await client.inbox()).total).toBe(1);
    expect(calls.map((c) => c[0])).toEqual(["stamp", "inbox", "stamp", "inbox"]);
  });

  test("a restarted client answers its copy and reads nothing more while the stamp holds", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "aos-outlook-")), "inbox-outlook.json");
    const first = fake({ stamp: { hash: "h1" }, inbox: { total: 1, messages: [mail] } });
    const read = await outlookClient(first.run, { copy: fileCopy(path, OutlookCopy) }).inbox();
    const again = fake({ stamp: { hash: "h1" } });
    const restarted = outlookClient(again.run, { copy: fileCopy(path, OutlookCopy) });
    expect(restarted.storedInbox()?.value).toEqual(read);
    expect(await restarted.inbox()).toEqual(read);
    expect(again.calls.map((c) => c[0])).toEqual(["stamp"]);
  });

  test("a mail id must be digits before the helper runs", async () => {
    const { run, calls } = fake({});
    await expect(outlookClient(run).message("1;2")).rejects.toBeInstanceOf(MacError);
    expect(calls).toEqual([]);
  });
});

// A helper with no `stamp` (bad_input): every inbox read is a whole one.
function app(answers: Record<string, unknown>, outlook = true) {
  const config = ConfigSchema.parse({ providers: { outlook } });
  const { run } = fake({ stamp: new MacError("bad_input"), ...answers });
  return macRoutes({ config }, macReads(run)).onError(errorHandler(SERVER_ERRORS));
}

describe("macRoutes", () => {
  test("off until the config turns Outlook on", async () => {
    const res = await app({}, false).request("/outlook/inbox");
    expect(await res.json()).toEqual({ disabled: true });
  });

  test("the inbox with its total", async () => {
    const res = await app({ inbox: { total: 300, messages: [mail] } }).request("/outlook/inbox");
    expect(await res.json()).toEqual({ total: 300, messages: [mail] });
  });

  test("a closed Mail is an error the page can name, not an empty inbox", async () => {
    const res = await app({ inbox: new MacError("mail_closed") }).request("/outlook/inbox");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("mail_closed");
  });

  test("rejects a bad day or mail id", async () => {
    expect((await app({}).request("/outlook/agenda?day=2026-02-30")).status).toBe(400);
    expect((await app({}).request("/outlook/messages/abc")).status).toBe(400);
  });

  test("«Dar permiso» opens the Calendars list only when macOS did not grant it", async () => {
    const config = ConfigSchema.parse({ providers: { outlook: true } });
    const grant = async (answer: unknown) => {
      let opened = 0;
      const { run } = fake({ grant: answer });
      const routes = macRoutes({ config }, macReads(run), async () => {
        opened++;
        return true;
      });
      const res = await routes.request("/outlook/grant", { method: "POST" });
      return { body: await res.json(), opened };
    };
    expect(await grant({ calendar: "granted", mail: "granted" })).toEqual({
      body: { calendar: "granted", settings: false },
      opened: 0,
    });
    expect(await grant({ calendar: "denied", mail: "granted" })).toEqual({
      body: { calendar: "denied", settings: true },
      opened: 1,
    });
    // A prompt nobody answered in time: the list opens as well.
    expect(await grant(new MacError("timeout"))).toEqual({
      body: { calendar: "unanswered", settings: true },
      opened: 1,
    });
  });

  test("a message gone from the inbox is a 404", async () => {
    const res = await app({ message: new MacError("not_found") }).request("/outlook/messages/7");
    expect(res.status).toBe(404);
  });
});
