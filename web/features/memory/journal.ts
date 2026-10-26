import { dayOf } from "../../../shared/days.ts";
import { clockTime } from "../../format.ts";
import { ticketsIn } from "./keys.ts";
import type { DocSummary } from "./queries.ts";

// The notes desk's plain logic: days, groups, and where a quick note is written.

export const NONE = "Sin ticket";

export const dayKey = (ms: number) => dayOf(new Date(ms));
const dateOf = (day: string) => new Date(`${day}T12:00:00`);

// "Hoy", "Ayer", the weekday within a week, else the full date (with the year past ~10 months).
export function dayLabel(day: string, now: number): string {
  const diff = Math.round((dateOf(dayKey(now)).getTime() - dateOf(day).getTime()) / 86_400_000);
  if (diff === 0) return "Hoy";
  if (diff === 1) return "Ayer";
  const opts: Intl.DateTimeFormatOptions =
    diff < 7
      ? { weekday: "long" }
      : {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: diff > 300 ? "numeric" : undefined,
        };
  return dateOf(day).toLocaleDateString("es-ES", opts);
}

export const shortDate = (day: string) =>
  dateOf(day).toLocaleDateString("es-ES", { day: "numeric", month: "short" });

// "hoy", "ayer" or the short date, for an entry listed outside its day.
export function shortDay(ms: number, now: number): string {
  const label = dayLabel(dayKey(ms), now);
  if (label === "Hoy" || label === "Ayer") return label.toLowerCase();
  return shortDate(dayKey(ms));
}

export type Group = { id: string; docs: DocSummary[] };

// Newest day first; the docs arrive newest first and keep that order.
export function groupByDay(docs: DocSummary[]): Group[] {
  const out = new Map<string, DocSummary[]>();
  for (const d of docs) out.set(dayKey(d.mtime), [...(out.get(dayKey(d.mtime)) ?? []), d]);
  return [...out].map(([id, list]) => ({ id, docs: list }));
}

// A note under each ticket it names; the ticket touched last comes first, «Sin ticket» last.
export function groupByTicket(docs: DocSummary[], keysOf: (d: DocSummary) => string[]): Group[] {
  const out = new Map<string, DocSummary[]>();
  for (const d of docs) {
    const keys = keysOf(d);
    for (const k of keys.length ? keys : [NONE]) out.set(k, [...(out.get(k) ?? []), d]);
  }
  return [...out]
    .sort((a, b) =>
      a[0] === NONE ? 1 : b[0] === NONE ? -1 : (b[1][0]?.mtime ?? 0) - (a[1][0]?.mtime ?? 0),
    )
    .map(([id, list]) => ({ id, docs: list }));
}

// Where a quick note goes: the note of the first ticket it names, so the desk lists it under
// that ticket, else today's journal. Both are plain notes named so their key or day shows.
export type CaptureTarget = { name: string; title: string; key: string | null };

export function captureTarget(
  text: string,
  projects: ReadonlySet<string>,
  summaryOf: (key: string) => string | undefined,
  now: number,
): CaptureTarget {
  const key = ticketsIn({ title: text, description: null, rel: "" }, projects)[0];
  if (key) {
    const summary = summaryOf(key);
    return { name: key, title: summary ? `${key} · ${summary}` : key, key };
  }
  const name = `Diario ${dayKey(now)}`;
  return { name, title: name, key: null };
}

// One journal line: the time, then the text on a single line.
export const entryLine = (now: number, text: string) =>
  `- ${clockTime(now)} ${text.trim().replace(/\s+/g, " ")}`;

// The line at the end of the note, on its own line.
export const appendLine = (body: string, line: string) =>
  `${body.length === 0 || body.endsWith("\n") ? body : `${body}\n`}${line}\n`;

// The body without its first `# heading` when that heading is the title the page already shows.
export function withoutTitle(body: string, title: string): string {
  const m = /^#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body);
  return m && m[1]?.trim() === title.trim() ? body.slice(m[0].length).replace(/^\s*\n/, "") : body;
}
