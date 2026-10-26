import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type MailInbox, MailThread } from "../../../shared/mail-inbox.ts";
import type { FileCopy } from "../../json-file.ts";
import { providerRequest } from "../../oauth.ts";
import { ProviderError } from "../../provider-error.ts";
import { traced } from "../../telemetry/span.ts";
import { GoogleReconnect, getAccessToken, googleConnection } from "./oauth.ts";

const GOOGLE = { provider: "google", label: "Google", getAccessToken };

// What the inbox shows: the whole inbox, newest first. A first read costs 40 quota units per
// thread (~18 s for 50 within Gmail's 6,000 a minute); later reads only fetch changed threads.
// ponytail: newest 50 and Gmail's estimate of the rest; page when the column needs more.
const INBOX_QUERY = "in:inbox";
const INBOX_MAX = 50;
// Mail out of the inbox that no label of the user's holds, and that they never answered: what
// the categorizer sorts beyond the inbox. 100 threads at 40 units fit in a minute of quota.
const OUTSIDE_QUERY = "-in:inbox -in:trash -in:spam -in:sent -in:chats -in:drafts has:nouserlabels";
const OUTSIDE_PAGE = 100;

const When = z.looseObject({ dateTime: z.string().optional(), date: z.string().optional() });
const Events = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string(),
        status: z.string().optional(),
        summary: z.string().optional(),
        htmlLink: z.string(),
        start: When,
        end: When,
        location: z.string().optional(),
        hangoutLink: z.string().optional(),
        attendees: z
          .array(
            z.looseObject({
              email: z.string().optional(),
              displayName: z.string().optional(),
              self: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
});

const ThreadList = z.looseObject({
  threads: z.array(z.looseObject({ id: z.string(), historyId: z.string() })).default([]),
  resultSizeEstimate: z.number().default(0),
  nextPageToken: z.string().optional(),
});
const Thread = z.looseObject({
  id: z.string(),
  messages: z
    .array(
      z.looseObject({
        labelIds: z.array(z.string()).default([]),
        internalDate: z.string(),
        snippet: z.string().default(""),
        payload: z.looseObject({
          headers: z.array(z.looseObject({ name: z.string(), value: z.string() })).default([]),
        }),
      }),
    )
    .min(1),
});

type Part = {
  mimeType?: string;
  headers: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
};
const Part: z.ZodType<Part> = z.lazy(() =>
  z.looseObject({
    mimeType: z.string().optional(),
    headers: z.array(z.looseObject({ name: z.string(), value: z.string() })).default([]),
    body: z.looseObject({ data: z.string().optional() }).optional(),
    parts: z.array(Part).optional(),
  }),
);
const FullThread = z.looseObject({
  id: z.string(),
  messages: z
    .array(z.looseObject({ id: z.string(), internalDate: z.string(), payload: Part }))
    .min(1),
});

const MessageList = z.looseObject({
  messages: z.array(z.looseObject({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});
const MessageMeta = z.looseObject({
  id: z.string(),
  labelIds: z.array(z.string()).default([]),
  payload: z.looseObject({
    headers: z.array(z.looseObject({ name: z.string(), value: z.string() })).default([]),
  }),
});
const Labels = z.looseObject({
  labels: z
    .array(z.looseObject({ id: z.string(), name: z.string(), type: z.string().optional() }))
    .default([]),
});

const Sorted = z.looseObject({ id: z.string() });

// Gmail thread ids are hex; nothing else reaches the URL.
export const THREAD_ID = /^[0-9a-f]{1,32}$/;
// What the reading panel shows of one message; longer bodies are cut and say so.
const MAX_BODY = 64 * 1024;

export type AgendaEvent = {
  source: "google" | "outlook";
  id: string;
  // Outlook repeats one id across a series: the instance's original start tells them apart.
  // Google lists each instance with its own id, so it has none.
  occurrence: string | null;
  title: string | null;
  // An RFC 3339 instant, or a date for an all-day event.
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  meet: string | null;
  // The event in its calendar's web app; Outlook's events have none to open.
  link: string | null;
  attendees: string[];
};

export type MailMessage = {
  id: string;
  from: string;
  to: string | null;
  cc: string | null;
  at: string;
  // Plain text: the text/plain part, or the HTML one reduced to text; null when there is none.
  body: string | null;
  truncated: boolean;
};

export type MailThreadFull = {
  id: string;
  subject: string | null;
  link: string;
  messages: MailMessage[];
};

export type SenderCount = { address: string; name: string; count: number };
export type SenderStat = SenderCount & { unread: number; category: string | null };

// What the user already does with their mail, read from Gmail before any AI looks at it: what
// they deleted (Gmail keeps 30 days of trash), where they file things, who they write to, and
// how much of each sender they leave unread. `sampled` says how much mail each answer rests on.
export type MailProfile = {
  trash: SenderCount[];
  labels: { name: string; senders: SenderCount[] }[];
  correspondents: SenderCount[];
  senders: SenderStat[];
  sampled: { trash: number; sent: number; recent: number; labels: number };
};

// "YYYY-MM-DD" as that local day's midnight; anything else is null.
export function parseDay(day: string | undefined): Date | null {
  const m = day?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return at.getDate() === Number(m[3]) ? at : null;
}

// The local day around `now`, as the server's clock (the Mac's) sees it.
export function dayWindow(now: Date): { timeMin: string; timeMax: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

export function toEvents(raw: z.infer<typeof Events>): AgendaEvent[] {
  return raw.items
    .filter((e) => e.status !== "cancelled")
    .flatMap((e) => {
      const start = e.start.dateTime ?? e.start.date;
      const end = e.end.dateTime ?? e.end.date;
      if (!start || !end) return [];
      return [
        {
          source: "google" as const,
          id: e.id,
          occurrence: null,
          title: e.summary ?? null,
          start,
          end,
          allDay: !e.start.dateTime,
          location: e.location ?? null,
          meet: e.hangoutLink ?? null,
          link: e.htmlLink,
          attendees: (e.attendees ?? []).flatMap((a) =>
            a.self ? [] : [a.displayName ?? a.email ?? ""].filter(Boolean),
          ),
        },
      ];
    });
}

// Gmail's snippets come HTML-escaped.
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? m;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

// An HTML mail as readable text: blocks become line breaks, tags go, entities are decoded.
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const parts = (p: Part): Part[] => [p, ...(p.parts ?? []).flatMap(parts)];
const decoded = (p: Part | undefined) =>
  p?.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : null;

function bodyText(payload: Part): string | null {
  const all = parts(payload);
  const plain = decoded(all.find((p) => p.mimeType === "text/plain" && p.body?.data));
  // Some senders label a whole HTML document as text/plain.
  if (plain?.trim())
    return /^\s*<(!doctype|html)\b/i.test(plain)
      ? htmlToText(plain) || null
      : plain.replace(/\r\n/g, "\n").trim();
  const html = decoded(all.find((p) => p.mimeType === "text/html" && p.body?.data));
  return html ? htmlToText(html) || null : null;
}

const threadLink = (email: string, id: string) =>
  `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#inbox/${id}`;

// "Ana Pérez <ana@x.com>" reads as its name; a bare address as itself.
const sender = (from: string) => from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "") || from;

export function toThread(raw: z.infer<typeof Thread>, email: string): MailThread {
  const last = raw.messages[raw.messages.length - 1] as (typeof raw.messages)[number];
  const header = (name: string) =>
    raw.messages[0]?.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
  const labels = new Set(raw.messages.flatMap((m) => m.labelIds));
  const from = last.payload.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
  return {
    id: raw.id,
    subject: header("subject"),
    from: sender(from),
    at: new Date(Number(last.internalDate)).toISOString(),
    snippet: decodeEntities(last.snippet),
    messages: raw.messages.length,
    unread: labels.has("UNREAD"),
    starred: labels.has("STARRED"),
    link: threadLink(email, raw.id),
  };
}

function toFullThread(raw: z.infer<typeof FullThread>, email: string): MailThreadFull {
  const header = (p: Part, name: string) =>
    p.headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
  return {
    id: raw.id,
    subject: header((raw.messages[0] as (typeof raw.messages)[number]).payload, "subject"),
    link: threadLink(email, raw.id),
    messages: raw.messages.map((m) => {
      const body = bodyText(m.payload);
      return {
        id: m.id,
        from: header(m.payload, "from") ?? "",
        to: header(m.payload, "to"),
        cc: header(m.payload, "cc"),
        at: new Date(Number(m.internalDate)).toISOString(),
        body: body && body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
        truncated: (body?.length ?? 0) > MAX_BODY,
      };
    }),
  };
}

// "Ana <ana@x.com>, bob@y.com" → each address, lower-cased, with its display name.
export function addresses(value: string): { address: string; name: string }[] {
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).flatMap((part) => {
    const m = part.match(/<([^>]+)>/) ?? part.match(/([^\s<>"]+@[^\s<>"]+)/);
    if (!m?.[1]) return [];
    return [{ address: m[1].trim().toLowerCase(), name: sender(part.trim()) }];
  });
}

const CATEGORIES = ["PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS", "PERSONAL"];
const category = (labels: string[]) =>
  CATEGORIES.find((c) => labels.includes(`CATEGORY_${c}`)) ?? null;

type Meta = z.infer<typeof MessageMeta>;
const header = (m: Meta, name: string) =>
  m.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

function tally(people: { address: string; name: string }[], top: number): SenderCount[] {
  const by = new Map<string, SenderCount>();
  for (const p of people) {
    const s = by.get(p.address) ?? { address: p.address, name: p.name, count: 0 };
    s.count += 1;
    by.set(p.address, s);
  }
  return [...by.values()].sort((a, b) => b.count - a.count).slice(0, top);
}

export function toProfile(input: {
  trash: Meta[];
  sent: Meta[];
  recent: Meta[];
  labels: { name: string; messages: Meta[] }[];
  me: string;
}): MailProfile {
  const from = (m: Meta) => addresses(header(m, "from")).slice(0, 1);
  const stats = new Map<string, SenderStat & { categories: Map<string, number> }>();
  for (const m of input.recent)
    for (const p of from(m)) {
      const s = stats.get(p.address) ?? {
        ...p,
        count: 0,
        unread: 0,
        category: null,
        categories: new Map(),
      };
      s.count += 1;
      if (m.labelIds.includes("UNREAD")) s.unread += 1;
      const c = category(m.labelIds);
      if (c) s.categories.set(c, (s.categories.get(c) ?? 0) + 1);
      stats.set(p.address, s);
    }
  return {
    trash: tally(input.trash.flatMap(from), 30),
    labels: input.labels
      .filter((l) => l.messages.length > 0)
      .map((l) => ({ name: l.name, senders: tally(l.messages.flatMap(from), 10) })),
    correspondents: tally(
      input.sent
        .flatMap((m) => [...addresses(header(m, "to")), ...addresses(header(m, "cc"))])
        .filter((p) => p.address !== input.me),
      30,
    ),
    senders: [...stats.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 50)
      .map(({ categories, ...s }) => ({
        ...s,
        category: [...categories].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      })),
    sampled: {
      trash: input.trash.length,
      sent: input.sent.length,
      recent: input.recent.length,
      labels: input.labels.reduce((n, l) => n + l.messages.length, 0),
    },
  };
}

// Runs `fn` over `items` with at most `limit` calls in flight, keeping the order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// How much each source of the profile reads: ~300 messages at 20 units fit in about a minute
// of quota. ponytail: samples, not the whole mailbox; the mail index (step L1) reads everything.
const PROFILE = { trash: 100, sent: 60, recent: 120, perLabel: 10, parallel: 8 };

// Gmail allows 6,000 quota units per minute per user (projects created after 2026-05-01);
// going over answers 403 to every Gmail call for a while. A token bucket: `burst` units at
// once, then `perSecond`, so a minute spends at most burst + 60 * perSecond.
export function quota(burst: number, perSecond: number) {
  let tokens = burst;
  let at = Date.now();
  return async (units: number) => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - at) / 1000) * perSecond) - units;
    at = now;
    // A span for the wait: a profile read spends most of its time here.
    if (tokens < 0)
      await traced("gmail quota wait", "wait", { units }, () =>
        Bun.sleep((-tokens / perSecond) * 1000),
      );
  };
}

// Units per call, from Gmail's quota table
// (developers.google.com/workspace/gmail/api/reference/quota).
const COST = {
  messages: 5,
  threads: 10,
  message: 20,
  thread: 40,
  labels: 1,
  label: 5,
  modify: 10,
  trash: 10,
};

// The reasons Gmail gives when the quota, not the request, is the problem.
const QUOTA_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);
export const overQuota = (err: unknown) =>
  err instanceof ProviderError &&
  (err.status === 429 || (err.status === 403 && QUOTA_REASONS.has(err.reason ?? "")));

// Waits before each retry over quota: Gmail asks for exponential backoff from 1 s.
const BACKOFF_MS = [2_000, 8_000, 30_000];

const newestFirst = (a: MailThread, b: MailThread) => b.at.localeCompare(a.at);

// The inbox as last read, kept on disk (`copy`): a restarted server answers it at once, and
// its history ids spare the reread of every thread that has not changed since.
export const GmailCopy = z.object({
  email: z.string(),
  total: z.number().int(),
  threads: z.array(z.object({ historyId: z.string(), thread: MailThread })),
});
export type GmailCopy = z.infer<typeof GmailCopy>;

export function googleClient(
  db: Database,
  {
    spend = quota(600, 85),
    wait = (ms: number) => Bun.sleep(ms),
    copy = null,
  }: {
    spend?: (units: number) => Promise<void>;
    wait?: (ms: number) => Promise<void>;
    copy?: FileCopy<GmailCopy> | null;
  } = {},
) {
  // Each attempt gets its own deadline inside providerRequest; the backoff sits between them.
  const gmail = async <S extends z.ZodType>(
    units: number,
    schema: S,
    url: string,
    path: string,
    init?: RequestInit,
  ): Promise<z.infer<S>> => {
    for (let attempt = 0; ; attempt++) {
      await spend(units);
      try {
        return await providerRequest(GOOGLE, schema, url, path, init);
      } catch (err) {
        const backoff = BACKOFF_MS[attempt];
        if (!overQuota(err)) throw err;
        if (backoff === undefined)
          throw new ProviderError(
            "google",
            429,
            `Gmail quota per minute is spent on ${path}; try again in a minute`,
          );
        await traced("gmail backoff", "wait", { attempt: attempt + 1 }, () =>
          wait(backoff + Math.random() * 1_000),
        );
      }
    }
  };
  // The inbox threads already read, by id with the history id they were read at: a thread
  // Gmail lists with the same history id has not changed, so it is not read again.
  // Kept for one account: a reconnect to another one starts empty.
  const stored = copy?.read();
  let known = new Map(stored?.value.threads.map((t) => [t.thread.id, t]));
  let knownFor = stored?.value.email ?? "";
  const account = () => {
    const conn = googleConnection(db);
    if (!conn) throw new GoogleReconnect("not connected");
    return conn;
  };

  async function agenda(now = new Date()): Promise<AgendaEvent[]> {
    account();
    const params = new URLSearchParams({
      ...dayWindow(now),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
    });
    const path = "/calendar/v3/calendars/primary/events";
    const raw = await providerRequest(
      GOOGLE,
      Events,
      `https://www.googleapis.com/${path.slice(1)}?${params}`,
      path,
    );
    return toEvents(raw);
  }

  // One list call, then a read only for the threads that are new or changed since last time.
  async function inbox(): Promise<MailInbox> {
    const { email } = account();
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
    const list = await gmail(
      COST.threads,
      ThreadList,
      `${base}?${new URLSearchParams({ q: INBOX_QUERY, maxResults: String(INBOX_MAX) })}`,
      "/gmail/threads",
    );
    const meta = "format=metadata&metadataHeaders=Subject&metadataHeaders=From";
    if (knownFor !== email) known = new Map();
    knownFor = email;
    const read = await Promise.all(
      list.threads.map(async (t) => {
        const seen = known.get(t.id);
        if (seen?.historyId === t.historyId) return [t.id, seen] as const;
        const raw = await gmail(COST.thread, Thread, `${base}/${t.id}?${meta}`, "/gmail/thread");
        return [t.id, { historyId: t.historyId, thread: toThread(raw, email) }] as const;
      }),
    );
    known = new Map(read);
    const total = Math.max(list.resultSizeEstimate, read.length);
    copy?.write({ email, total, threads: read.map(([, r]) => r) });
    return { threads: read.map(([, r]) => r.thread).sort(newestFirst), total };
  }

  // One page of mail outside the inbox under no label, newest first; `next` reads on.
  async function outside(
    page?: string,
  ): Promise<{ threads: MailThread[]; next: string | null; total: number }> {
    const { email } = account();
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
    const params = new URLSearchParams({ q: OUTSIDE_QUERY, maxResults: String(OUTSIDE_PAGE) });
    if (page) params.set("pageToken", page);
    const list = await gmail(COST.threads, ThreadList, `${base}?${params}`, "/gmail/threads");
    const meta = "format=metadata&metadataHeaders=Subject&metadataHeaders=From";
    const threads = await mapLimit(list.threads, 8, async (t) =>
      toThread(await gmail(COST.thread, Thread, `${base}/${t.id}?${meta}`, "/gmail/thread"), email),
    );
    return { threads, next: list.nextPageToken ?? null, total: list.resultSizeEstimate };
  }

  // The stored inbox, while it belongs to the connected account: what a restarted server
  // answers first.
  function storedInbox(): { at: number; value: MailInbox } | undefined {
    if (!stored || stored.value.email !== googleConnection(db)?.email) return undefined;
    const { threads, total } = stored.value;
    return {
      at: stored.at,
      value: { threads: threads.map((t) => t.thread).sort(newestFirst), total },
    };
  }

  // One thread with its bodies, read when the user opens it; never stored.
  async function thread(id: string): Promise<MailThreadFull> {
    if (!THREAD_ID.test(id)) throw new Error(`invalid thread id ${id}`);
    const { email } = account();
    const raw = await gmail(
      COST.thread,
      FullThread,
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=full`,
      "/gmail/thread",
    );
    return toFullThread(raw, email);
  }

  const messages = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  // Up to `max` message ids for a Gmail search, newest first, page by page.
  async function search(q: string, max: number, labelId?: string): Promise<string[]> {
    const ids: string[] = [];
    let page: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        maxResults: String(Math.min(500, max - ids.length)),
      });
      if (page) params.set("pageToken", page);
      if (labelId) params.set("labelIds", labelId);
      const list = await gmail(
        COST.messages,
        MessageList,
        `${messages}?${params}`,
        "/gmail/messages",
      );
      ids.push(...list.messages.map((m) => m.id));
      page = list.nextPageToken;
    } while (page && ids.length < max);
    return ids;
  }
  const metas = (ids: string[]) =>
    mapLimit(ids, PROFILE.parallel, (id) =>
      gmail(
        COST.message,
        MessageMeta,
        `${messages}/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
        "/gmail/message",
      ),
    );

  async function profile(): Promise<MailProfile> {
    const { email } = account();
    const labels = await gmail(
      COST.labels,
      Labels,
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      "/gmail/labels",
    );
    const own = labels.labels.filter((l) => l.type === "user");
    const [trash, sent, recent, filed] = await Promise.all([
      search("in:trash", PROFILE.trash).then(metas),
      search("in:sent", PROFILE.sent).then(metas),
      search("-in:sent -in:trash -in:spam -in:chats", PROFILE.recent).then(metas),
      mapLimit(own, 2, async (l) => ({
        name: l.name,
        // By id: Gmail's search syntax mangles label names with spaces or slashes.
        messages: await search("", PROFILE.perLabel, l.id).then(metas),
      })),
    ]);
    return toProfile({ trash, sent, recent, labels: filed, me: email.toLowerCase() });
  }

  // The user's own labels, where a thread may be filed.
  async function labels(): Promise<{ id: string; name: string }[]> {
    account();
    const raw = await gmail(
      COST.labels,
      Labels,
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      "/gmail/labels",
    );
    return raw.labels.filter((l) => l.type === "user").map(({ id, name }) => ({ id, name }));
  }

  // A new label of the user's, shown in Gmail's list; its id.
  async function createLabel(name: string): Promise<string> {
    account();
    const made = await gmail(
      COST.label,
      Sorted,
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      "/gmail/label/create",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        }),
      },
    );
    return made.id;
  }

  // Files an inbox thread under a label, out of the inbox, archives it under no label, or moves
  // it to the trash (Gmail empties it after 30 days). Nothing else: no send, no delete for good.
  async function sortThread(
    id: string,
    to: { trash: true } | { labelId: string } | { archive: true },
  ) {
    if (!THREAD_ID.test(id)) throw new Error(`invalid thread id ${id}`);
    account();
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}`;
    if ("trash" in to)
      await gmail(COST.trash, Sorted, `${url}/trash`, "/gmail/thread/trash", { method: "POST" });
    else
      await gmail(COST.modify, Sorted, `${url}/modify`, "/gmail/thread/modify", {
        method: "POST",
        body: JSON.stringify({
          addLabelIds: "labelId" in to ? [to.labelId] : [],
          removeLabelIds: ["INBOX"],
        }),
      });
  }

  return {
    agenda,
    inbox,
    storedInbox,
    thread,
    profile,
    labels,
    createLabel,
    outside,
    sortThread,
    connection: () => googleConnection(db),
  };
}

// Who the token belongs to, asked once when the OAuth callback lands.
export async function fetchProfile(accessToken: string): Promise<{ emailAddress: string }> {
  return providerRequest(
    { ...GOOGLE, getAccessToken: async () => accessToken },
    z.looseObject({ emailAddress: z.string() }),
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    "/gmail/profile",
  );
}
