// Count and time wording shared by every page.

export const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("es-ES")} ${n === 1 ? one : many}`;

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];
const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto", style: "short" });

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Number.isNaN(seconds)) return "";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.trunc(seconds / size), unit);
  }
  return "ahora";
}

const hhmm = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" });

// "07:05": a time of day, from a timestamp in ms or an ISO string.
export const clockTime = (at: number | string) => hhmm.format(new Date(at));

// "1:05": a duration in whole seconds.
export const minSec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// "340 KB", "1.2 MB": a file's size.
export const byteSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
