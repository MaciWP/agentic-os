import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailInbox, OutlookInbox } from "../../../shared/mail-inbox.ts";
import type { MailAccount, Proposal } from "../../../shared/mail-sort.ts";
import type { Meeting, MeetingSync } from "../../../shared/meetings.ts";
import { ApiError, api, mutate, serverCachedQuery, unwrap } from "../../api.ts";
import { pollEvery } from "../../poll.ts";
import { type StoredValue, storageKey } from "../../storage.ts";

// The server keeps each list for a minute; the page asks again at that pace. Past it the
// server answers its copy at once and says when the new one differs (topics "google", "mac").
const EVERY_MS = 60_000;

// Inicio's reads stay in the browser half an hour, so coming back draws the last copy at once.
// A failure the server named (Mail closed, no grant, Google disconnected) is its answer and
// shows at once; only a failure with no name, a dropped connection, is tried again.
const INICIO = {
  gcTime: 30 * 60_000,
  retry: (failures: number, err: Error) =>
    failures < 1 && !(err instanceof ApiError && err.code !== "http_error"),
};

export function useAgenda() {
  return useQuery({
    ...INICIO,
    queryKey: ["google", "agenda"],
    queryFn: async () => unwrap(await api.api.google.agenda.$get()),
    refetchInterval: pollEvery(EVERY_MS),
  });
}

// The last inbox this browser read: a reopened page (a phone, a remote PC) draws it at once and
// reads it again behind it, since `initialDataUpdatedAt: 0` makes it stale. A failed read still
// shows as one (today/parts.tsx Section); a provider turned off is never kept.
const gmailCopy = storageKey("aos.inicio.mail.gmail", {
  schema: MailInbox.nullable(),
  fallback: null,
  codec: "json",
});
const outlookCopy = storageKey("aos.inicio.mail.outlook", {
  schema: OutlookInbox.nullable(),
  fallback: null,
  codec: "json",
});

function keptInbox<T extends object>(
  copy: StoredValue<T | null>,
  read: () => Promise<T | { disabled: true }>,
) {
  return {
    initialData: () => copy.get() ?? undefined,
    initialDataUpdatedAt: 0,
    queryFn: async () => {
      const data = await read();
      if (!("disabled" in data)) copy.set(data);
      return data;
    },
  };
}

export function useMail() {
  return useQuery({
    ...INICIO,
    queryKey: ["google", "inbox"],
    ...keptInbox(gmailCopy, async () => unwrap(await api.api.google.inbox.$get())),
    refetchInterval: pollEvery(EVERY_MS),
  });
}

// A thread is read only once it is opened.
export function useThread(id: string | null) {
  return useQuery({
    queryKey: ["google", "thread", id],
    queryFn: async () =>
      unwrap(await api.api.google.threads[":id"].$get({ param: { id: id ?? "" } })),
    enabled: id !== null,
  });
}

// What the user does with their mail: ~1,500 Gmail reads, so the server keeps it 30 minutes and
// «Volver a leer» asks for a fresh one.
const profile = serverCachedQuery(["google", "cleanup", "profile"], async (query) =>
  unwrap(await api.api.google.cleanup.profile.$get({ query })),
);

export function useMailProfile(enabled: boolean) {
  const client = useQueryClient();
  return { q: useQuery({ ...profile.query, enabled }), reload: () => profile.refresh(client) };
}

// Outlook through the Mac (server/features/mac): the same pace as Google.
export function useOutlookAgenda() {
  return useQuery({
    ...INICIO,
    queryKey: ["mac", "outlook", "agenda"],
    queryFn: async () => unwrap(await api.api.mac.outlook.agenda.$get()),
    refetchInterval: pollEvery(EVERY_MS),
  });
}

export function useOutlookInbox() {
  return useQuery({
    ...INICIO,
    queryKey: ["mac", "outlook", "inbox"],
    ...keptInbox(outlookCopy, async () => unwrap(await api.api.mac.outlook.inbox.$get())),
    refetchInterval: pollEvery(EVERY_MS),
  });
}

// «Dar permiso»: macOS's Calendars prompt on the Mac, or the Settings list when it does not ask.
type CalendarGrant = { calendar: "granted" | "denied" | "unanswered"; settings: boolean };
export const grantCalendar = () => mutate<CalendarGrant>("/api/mac/outlook/grant", "POST");

export function useOutlookMessage(id: string | null) {
  return useQuery({
    queryKey: ["mac", "outlook", "message", id],
    queryFn: async () =>
      unwrap(await api.api.mac.outlook.messages[":id"].$get({ param: { id: id ?? "" } })),
    enabled: id !== null,
    retry: false,
  });
}

// What the calendars said today, recorded on the server, which answers the day's meetings with
// their ids. A write, so a POST; idempotent, so it runs as a query keyed by what was read. The
// last answer stays while a new read syncs.
export function useMeetingSync(body: MeetingSync, enabled = true) {
  return useQuery({
    ...INICIO,
    queryKey: ["meetings", "day", body],
    enabled,
    queryFn: () => mutate<{ meetings: Meeting[] }>("/api/meetings/sync", "POST", body),
    placeholderData: keepPreviousData,
  });
}

// Meetings of earlier days never closed: the carry-over.
export function useOpenMeetings(before: string) {
  return useQuery({
    ...INICIO,
    queryKey: ["meetings", "open", before],
    queryFn: async () => unwrap(await api.api.meetings.open.$get({ query: { before } })),
  });
}

export function useMeetingActions() {
  const client = useQueryClient();
  const after = async <T>(p: Promise<T>) => {
    const out = await p;
    await client.invalidateQueries({ queryKey: ["meetings"] });
    return out;
  };
  return {
    close: (id: number) => after(mutate<{ meeting: Meeting }>(`/api/meetings/${id}/close`, "POST")),
    reopen: (id: number) =>
      after(mutate<{ meeting: Meeting }>(`/api/meetings/${id}/reopen`, "POST")),
    // The meeting's note, made from the template the first time.
    note: (id: number, attendees: string[]) =>
      after(
        mutate<{ meeting: Meeting; noteId: string }>(`/api/meetings/${id}/note`, "POST", {
          attendees,
        }),
      ),
    closeBefore: (before: string) =>
      after(mutate<{ closed: number }>("/api/meetings/close-before", "POST", { before })),
  };
}

// The mail categorizer's pending proposal for one account (server/features/mail): read again
// when the server's "mail" event says an agent sent a new one.
export function useProposal(account: MailAccount) {
  return useQuery({
    ...INICIO,
    queryKey: ["mail", "proposal", account],
    queryFn: async () =>
      unwrap(await api.api.mail[":account"].proposal.$get({ param: { account } })),
  });
}

export function useSortActions() {
  const client = useQueryClient();
  const after = async <T>(p: Promise<T>) => {
    try {
      return await p;
    } finally {
      // A cancelled dialog changed nothing, but a timeout may have moved some mail.
      await Promise.all(
        [["mail"], ["mac", "outlook", "inbox"], ["google", "inbox"]].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      );
    }
  };
  return {
    // Opens the dialog on the Mac and waits for the click, up to two minutes.
    apply: (id: number, keep: string[]) =>
      after(mutate<{ proposal: Proposal }>(`/api/mail/proposals/${id}/apply`, "POST", { keep })),
    discard: (id: number) =>
      after(mutate<{ proposal: Proposal }>(`/api/mail/proposals/${id}/discard`, "POST")),
  };
}
