// Local calendar days as YYYY-MM-DD, shared by the usage report and the page that asks for it.

const pad = (n: number) => String(n).padStart(2, "0");

export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const daysBefore = (d: Date, n: number) =>
  dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));

const dateOf = (day: string) => {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// Every day from `from` to `to`, both included; none when `from` is after `to`.
export function daysFrom(from: string, to: string): string[] {
  const start = dateOf(from);
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const day = daysBefore(start, -i);
    if (day > to) return out;
    out.push(day);
  }
}

// The Monday that starts a day's week.
export function weekOf(day: string): string {
  const d = dateOf(day);
  return daysBefore(d, (d.getDay() + 6) % 7);
}
