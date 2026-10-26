import type { AgendaEvent } from "../../../server/features/google/client.ts";
import type { MailThread, OutlookInbox } from "../../../shared/mail-inbox.ts";
import type { Meeting, MeetingSync } from "../../../shared/meetings.ts";
import type { NewGoal, Task } from "../../../shared/objectives.ts";
import { parseTask } from "../../../shared/task-parse.ts";

// «Hoy», the centre of Inicio, as plain data: the day's meetings and timed tasks by the clock,
// the tasks with no time by the user's order, and what earlier days left open. Nothing here
// reads or writes; the page passes what it read and draws what comes back.

const DAY_MS = 24 * 3600_000;
const pad = (n: number) => String(n).padStart(2, "0");

export type Day = { from: string; to: string; day: string };

// The local day `offset` days from `now`, as the [from, to) and date the server filters by.
export function localDay(offset: number, now = new Date()): Day {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + 1);
  const day = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  return { from: start.toISOString(), to: end.toISOString(), day };
}

// "desde ayer", "desde hace 3 días": how long an open task has been carried, by local days.
export function carried(createdAt: string, dayFrom: string) {
  const created = new Date(createdAt);
  const midnight = new Date(created.getFullYear(), created.getMonth(), created.getDate());
  const days = Math.round((Date.parse(dayFrom) - midnight.getTime()) / DAY_MS);
  return days <= 0 ? null : days === 1 ? "desde ayer" : `desde hace ${days} días`;
}

// The local "HH:MM" of an instant: what a timed task's due time compares with.
const localHm = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// One calendar event and the meeting the server keeps for it. The database stores no
// occurrence as '' and answers null; both sides fold to "".
export const meetingKey = (source: string, key: string, occurrence: string | null) =>
  `${source}|${key}|${occurrence ?? ""}`;

type Calendars = { google?: AgendaEvent[]; outlook?: AgendaEvent[] };

// What the browser tells the server it read. Only a calendar that answered is named: one still
// loading, failed or off would otherwise read as "everything cancelled". With none, the sync
// changes nothing and answers the meetings the server kept for the day.
export function syncBody(day: Day, read: Calendars): MeetingSync {
  const sources = (["google", "outlook"] as const).filter((s) => read[s] !== undefined);
  return {
    from: day.from,
    to: day.to,
    sources,
    events: sources.flatMap((s) =>
      (read[s] ?? []).map((e) => ({
        source: s,
        eventKey: e.id,
        occurrence: e.occurrence,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
      })),
    ),
  };
}

export type MeetingRow = {
  kind: "meeting";
  key: string;
  // Local "HH:MM", or "" for an all-day event, which goes first.
  at: string;
  source: "google" | "outlook";
  title: string | null;
  start: string;
  end: string;
  allDay: boolean;
  // Known once the sync answers: what closing and notes act on.
  meeting: Meeting | null;
  // Known while the calendar answers: the join link and the people.
  event: AgendaEvent | null;
};
export type TaskRow = { kind: "task"; key: string; at: string; task: Task; note: string | null };
export type TimedRow = MeetingRow | TaskRow;

// Done on that day: closed inside it. Closed later means it was still open then.
export const isDone = (t: Task, day: Day) => t.closedAt !== null && t.closedAt < day.to;

// What an open task carries beside its title: overdue, or how long it has been carried.
function noteOf(t: Task, day: Day): string | null {
  if (isDone(t, day)) return null;
  if (t.dueOn && t.dueOn < day.day) return "vencida";
  return carried(t.createdAt, day.from);
}

// The day by the clock: every event read today joined to its meeting, a meeting the server kept
// whose calendar failed this time, and the tasks due today at a time.
export function timedRows(
  day: Day,
  events: AgendaEvent[],
  meetings: Meeting[],
  tasks: Task[],
): TimedRow[] {
  const bySeen = new Map(meetings.map((m) => [meetingKey(m.source, m.eventKey, m.occurrence), m]));
  const rows: TimedRow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.source !== "google" && e.source !== "outlook") continue;
    const key = meetingKey(e.source, e.id, e.occurrence);
    seen.add(key);
    rows.push({
      kind: "meeting",
      key,
      at: e.allDay ? "" : localHm(e.start),
      source: e.source,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      meeting: bySeen.get(key) ?? null,
      event: e,
    });
  }
  for (const [key, m] of bySeen)
    if (!seen.has(key) && m.start >= day.from && m.start < day.to)
      rows.push({
        kind: "meeting",
        key,
        at: m.allDay ? "" : localHm(m.start),
        source: m.source,
        title: m.title,
        start: m.start,
        end: m.end,
        allDay: m.allDay,
        meeting: m,
        event: null,
      });
  for (const t of tasks)
    if (t.dueHm && t.dueOn === day.day)
      rows.push({ kind: "task", key: `task:${t.id}`, at: t.dueHm, task: t, note: noteOf(t, day) });
  // A meeting before a task at the same minute: the task is usually its follow-up.
  return rows.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === "meeting" ? -1 : 1));
}

// The user's order: a task never moved sorts by when it was made, after the moved ones' ranks.
export const rank = (t: Task) => t.position ?? t.id;

// The tasks with no time today, open ones first: priority, then the user's order.
export function untimedRows(day: Day, tasks: Task[]): TaskRow[] {
  return tasks
    .filter((t) => !(t.dueHm && t.dueOn === day.day))
    .sort(
      (a, b) =>
        Number(isDone(a, day)) - Number(isDone(b, day)) ||
        b.priority - a.priority ||
        rank(a) - rank(b),
    )
    .map((t) => ({ kind: "task", key: `task:${t.id}`, at: "", task: t, note: noteOf(t, day) }));
}

// The position that moves row `index` one step up or down among the open rows of its
// priority, or null when it is already at that end. Halfway between the new neighbours, so
// one write moves one task.
export function moved(rows: Task[], index: number, step: -1 | 1): number | null {
  const t = rows[index];
  const target = rows[index + step];
  if (!t || !target || target.priority !== t.priority || target.closedAt !== null) return null;
  const beyond = rows[index + 2 * step];
  const edge =
    beyond && beyond.priority === t.priority && beyond.closedAt === null
      ? rank(beyond)
      : rank(target) + step;
  return (rank(target) + edge) / 2;
}

// The position that puts a dragged task just before `before` in `rows`.
export function placedBefore(rows: Task[], before: number): number {
  const at = rows.findIndex((t) => t.id === before);
  const target = rows[at];
  if (!target) return rows.length > 0 ? Math.max(...rows.map(rank)) + 1 : 1;
  const prev = rows[at - 1];
  return prev ? (rank(prev) + rank(target)) / 2 : rank(target) - 1;
}

// One mail as both columns draw it. `key` is what a task keeps to find it again: Outlook's
// RFC Message-ID (Mail's own id changes when the mail moves), Gmail's thread id.
export type MailItem = {
  account: "outlook" | "gmail";
  id: string;
  key: string;
  from: string;
  subject: string | null;
  at: string;
  unread: boolean;
  flagged: boolean;
  snippet: string | null;
};

export const fromOutlook = (m: OutlookInbox["messages"][number]): MailItem => ({
  account: "outlook",
  id: m.id,
  key: m.messageId,
  from: m.from.replace(/\s*<[^>]*>$/, "") || m.from,
  subject: m.subject,
  at: m.at,
  unread: m.unread,
  flagged: m.flagged,
  snippet: null,
});

export const fromGmail = (t: MailThread): MailItem => ({
  account: "gmail",
  id: t.id,
  key: t.id,
  from: t.from,
  subject: t.subject,
  at: t.at,
  unread: t.unread,
  flagged: t.starred,
  snippet: t.snippet,
});

// What a mail dragged to «Hoy» (or its «Tarea» button) becomes: its subject read by the same
// rules as a typed task, linked to the mail so a second drop makes nothing new.
export function taskFromMail(m: Pick<MailItem, "account" | "key" | "subject">, now = new Date()) {
  const subject = (m.subject ?? "").trim() || "(sin asunto)";
  const p = parseTask(subject.slice(0, 200), now);
  const goal: NewGoal = {
    title: p.title.slice(0, 200),
    dueOn: p.dueOn,
    dueHm: p.dueHm,
    priority: p.priority,
    about: p.about,
    source: `mail:${m.account}`,
    sourceKey: m.key.slice(0, 300),
  };
  return goal;
}

// The drag payload between a mail column and «Hoy».
export const MAIL_DRAG = "application/x-aos-mail";
export const TASK_DRAG = "application/x-aos-task";

type Read<T> = { isPending: boolean; isError: boolean; data?: T | { disabled: true } };
const answered = <T extends object>(r: Read<T>) =>
  r.data && !("disabled" in r.data) ? r.data : undefined;

// The calendars that answered, for the sync and the summary.
export function calendarsOf(
  google: Read<{ events: AgendaEvent[] }>,
  outlook: Read<{ events: AgendaEvent[] }>,
): Calendars {
  return { google: answered(google)?.events, outlook: answered(outlook)?.events };
}

// Both calendars as one read for the line on top: loading while either loads, failed only when
// every calendar that is on failed, off when both are off. A failure of one shows in «Hoy».
export function mergedAgenda(
  google: Read<{ events: AgendaEvent[] }>,
  outlook: Read<{ events: AgendaEvent[] }>,
): Read<{ events: AgendaEvent[] }> {
  const off = (r: Read<unknown>) =>
    Boolean(r.data && typeof r.data === "object" && "disabled" in r.data);
  const on = [google, outlook].filter((r) => !off(r));
  if (on.length === 0) return { isPending: false, isError: false, data: { disabled: true } };
  if (on.some((r) => r.isPending)) return { isPending: true, isError: false };
  const events = on.flatMap((r) => answered(r as Read<{ events: AgendaEvent[] }>)?.events ?? []);
  if (on.every((r) => r.isError)) return { isPending: false, isError: true };
  return {
    isPending: false,
    isError: false,
    data: { events: events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) },
  };
}

// The assigned tickets last in «Hoy»: in progress first, nothing done.
export function ticketOrder<T extends { status: { category: string } }>(tickets: T[]): T[] {
  const order: Record<string, number> = { indeterminate: 0, new: 1 };
  return tickets
    .filter((t) => t.status.category !== "done")
    .sort((a, b) => (order[a.status.category] ?? 2) - (order[b.status.category] ?? 2));
}

// A meeting note's open checklist: the text of each `- [ ]` line that has some.
export function checklist(body: string): string[] {
  return body.split("\n").flatMap((line) => {
    const m = /^\s*[-*+]\s+\[ \]\s+(\S.*)$/.exec(line);
    return m?.[1] ? [m[1].trim()] : [];
  });
}

// What made a task from a note: the meeting, and the line as written (spaces and case aside),
// so a line already passed is never made twice and an edited line is a new task.
export const noteSource = (meetingId: number) => `meeting:${meetingId}`;
const lineKey = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);

// The lines of the note not made into tasks yet, once each.
export function pendingLines(lines: string[], made: Pick<Task, "sourceKey">[]): string[] {
  const seen = new Set(made.map((t) => t.sourceKey));
  return lines.filter((line) => {
    const key = lineKey(line);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Each pending line as a task, read by the same rules as a typed one. The batch takes 50.
export function tasksFromNote(meetingId: number, lines: string[], now = new Date()): NewGoal[] {
  return lines.slice(0, 50).map((line) => {
    const p = parseTask(line.slice(0, 200), now);
    return {
      title: p.title.slice(0, 200),
      dueOn: p.dueOn,
      dueHm: p.dueHm,
      priority: p.priority,
      about: p.about,
      source: noteSource(meetingId),
      sourceKey: lineKey(line),
    };
  });
}
