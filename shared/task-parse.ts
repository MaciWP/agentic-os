// What a task line says beyond its title, read by fixed rules (no AI): a day, a time, urgency
// and the ticket it is about. Each find is a chip the user can remove; a removed chip's words
// stay in the title. Nothing found means the defaults: no day (today), no time, normal.

export type ChipKind = "day" | "time" | "priority" | "about";
export type Chip = { kind: ChipKind; label: string };
export type ParsedTask = {
  title: string;
  dueOn: string | null;
  dueHm: string | null;
  priority: 0 | 1;
  about: string | null;
  chips: Chip[];
};

const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Accents fold to plain letters, one character for one, so match offsets stay the same.
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const foldKeep = (s: string) =>
  [...s].map((ch) => (fold(ch).length === 1 ? fold(ch) : ch.toLowerCase())).join("");

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (now: Date, days: number) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
const dayLabel = (d: Date, now: Date) => {
  const diff = Math.round((plus(d, 0).getTime() - plus(now, 0).getTime()) / 86_400_000);
  if (diff === 0) return "hoy";
  if (diff === 1) return "mañana";
  if (diff === 2) return "pasado mañana";
  const weekday = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][d.getDay()];
  return `${weekday} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

type Find = { kind: ChipKind; start: number; end: number; keep?: boolean } & (
  | { kind: "day"; date: Date }
  | { kind: "time"; hm: string }
  | { kind: "priority" }
  | { kind: "about"; key: string }
);

// The rules, longest first inside each kind: «pasado mañana» before «mañana».
function finds(text: string, now: Date): Find[] {
  const t = foldKeep(text);
  const out: Find[] = [];
  const first = (re: RegExp) => re.exec(t);

  const day = (() => {
    const after = first(/\bpasado manana\b/);
    if (after) return { m: after, date: plus(now, 2) };
    // «por la mañana» is a time of day, not tomorrow.
    const tomorrow = /(?<!\b(?:la|esta|de) )\bmanana\b/.exec(t);
    if (tomorrow) return { m: tomorrow, date: plus(now, 1) };
    const today = first(/\bhoy\b/);
    if (today) return { m: today, date: plus(now, 0) };
    const weekday = first(
      /\b(?:(?:el|este|proximo|el proximo) )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/,
    );
    if (weekday) {
      // The next one: on a Friday, «viernes» is a week from today.
      const ahead = (WEEKDAYS.indexOf(weekday[1] as string) - now.getDay() + 7) % 7 || 7;
      return { m: weekday, date: plus(now, ahead) };
    }
    const slash = first(/\b([0-3]?\d)\/([01]?\d)\b/);
    if (slash) {
      const [d, mo] = [Number(slash[1]), Number(slash[2]) - 1];
      let date = new Date(now.getFullYear(), mo, d);
      if (date.getMonth() !== mo) return null;
      if (date < plus(now, 0)) date = new Date(now.getFullYear() + 1, mo, d);
      return { m: slash, date };
    }
    const nth = first(/\bel (?:dia )?([0-3]?\d)\b(?!:)/);
    if (nth) {
      const d = Number(nth[1]);
      if (d < 1 || d > 31) return null;
      // A day already gone this month is next month's.
      for (let k = d < now.getDate() ? 1 : 0; k < 3; k++) {
        const date = new Date(now.getFullYear(), now.getMonth() + k, d);
        if (date.getDate() === d) return { m: nth, date };
      }
    }
    return null;
  })();
  if (day)
    out.push({
      kind: "day",
      start: day.m.index,
      end: day.m.index + day.m[0].length,
      date: day.date,
    });

  const clock = first(/\b(?:a las? )?([01]?\d|2[0-3]):([0-5]\d)\s*h?\b/);
  const atHour = first(/\ba las? ([01]?\d|2[0-3])(?:\s*h\b)?(?! ?[:\d])( de la manana)?/);
  const hourH = first(/\b([01]?\d|2[0-3])h\b/);
  if (clock) {
    let h = Number(clock[1]);
    if (/^a las? /.test(clock[0]) && h >= 1 && h <= 7) h += 12;
    out.push({
      kind: "time",
      start: clock.index,
      end: clock.index + clock[0].length,
      hm: `${pad(h)}:${clock[2]}`,
    });
  } else if (atHour) {
    let h = Number(atHour[1]);
    // «a las 4» is four in the afternoon at work; «a las 4 de la mañana» says otherwise.
    if (h >= 1 && h <= 7 && !atHour[2]) h += 12;
    out.push({
      kind: "time",
      start: atHour.index,
      end: atHour.index + atHour[0].length,
      hm: `${pad(h)}:00`,
    });
  } else if (hourH) {
    out.push({
      kind: "time",
      start: hourH.index,
      end: hourH.index + hourH[0].length,
      hm: `${pad(Number(hourH[1]))}:00`,
    });
  }

  const urgent = /(?<!\bno )\b(urgente|importante)\b|(?:^|\s)(!+)(?=\s|$)|(?<=\S)(!+)$/.exec(t);
  if (urgent) {
    const word = Boolean(urgent[1]);
    const start = urgent.index + (urgent[0].length - urgent[0].trimStart().length);
    // A word stays in the title: «revisar contrato urgente» still reads right.
    out.push({ kind: "priority", start, end: urgent.index + urgent[0].length, keep: word });
  }

  const key = /\b[A-Z][A-Z0-9_]+-\d+\b/.exec(text);
  if (key)
    out.push({
      kind: "about",
      start: key.index,
      end: key.index + key[0].length,
      keep: true,
      key: key[0],
    });
  return out;
}

export function parseTask(
  text: string,
  now = new Date(),
  drop: ReadonlySet<ChipKind> = new Set(),
): ParsedTask {
  const found = finds(text, now).filter((f) => !drop.has(f.kind));
  const cut = found.filter((f) => !f.keep).sort((a, b) => b.start - a.start);
  let title = text;
  for (const f of cut) title = `${title.slice(0, f.start)} ${title.slice(f.end)}`;
  title = title
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[\s,.;:-]+|[\s,;:-]+$/g, "");
  const parsed: ParsedTask = {
    title: title || text.trim(),
    dueOn: null,
    dueHm: null,
    priority: 0,
    about: null,
    chips: [],
  };
  for (const f of found) {
    if (f.kind === "day") {
      parsed.dueOn = isoDay(f.date);
      parsed.chips.push({ kind: "day", label: dayLabel(f.date, now) });
    } else if (f.kind === "time") {
      parsed.dueHm = f.hm;
      parsed.chips.push({ kind: "time", label: f.hm });
    } else if (f.kind === "priority") {
      parsed.priority = 1;
      parsed.chips.push({ kind: "priority", label: "prioridad" });
    } else {
      parsed.about = f.key;
      parsed.chips.push({ kind: "about", label: f.key });
    }
  }
  // A time with no day is today's.
  if (parsed.dueHm && !parsed.dueOn) parsed.dueOn = isoDay(now);
  return parsed;
}
