import type { Database } from "bun:sqlite";
import { dayOf, daysBefore, daysFrom } from "../../../shared/days.ts";
import { type Objective, objectiveKey, objectiveLabel } from "../../../shared/objectives.ts";
import type { Config } from "../../config.ts";
import { type Place, placeOf } from "./place-of.ts";
import { type Counts, costOf, LONG, type Price, priceOf } from "./pricing.ts";
import type {
  DailySeries,
  HookLine,
  TicketUsage,
  UsageLine,
  UsageReport,
  UsageSession,
  UsageTokens,
} from "./types.ts";

// What the transcripts add up to between two days (ADR 0008). The ticket and the env come
// from each call's folder and branch, and the cost from the prices in the config, both when
// read: a new price or a new env layout applies to the whole history.

type UsageRow = Counts & {
  harness: string;
  session_id: string;
  place_id: number;
  agent: string;
  role: string;
  // The effort level the calls ran at; '' when unsaid.
  effort: string;
  // 1 when the calls' prompts were over LONG_PROMPT tokens.
  long: number;
  skill: string;
  model: string;
  // The UTC hour, YYYY-MM-DDTHH: a whole hour falls in one local day.
  hour: string;
  calls: number;
  first: string;
  last: string;
};
type EventRow = { kind: string; name: string; detail: string; n: number };
type PlaceRow = { id: number; cwd: string; branch: string };
export type Places = Map<number, Place & { cwd: string; branch: string }>;

const zero = (): UsageTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
export const tokensOf = (r: Counts) =>
  r.input + r.cache_read + r.cache_write + r.cache_write_1h + r.output;
const emptyLine = (key: string): UsageLine => ({
  key,
  calls: 0,
  tokens: zero(),
  cost: null,
  unpricedTokens: 0,
  longCalls: 0,
  saved: null,
});
// The local day of a UTC hour.
const dayOfHour = (hour: string) => dayOf(new Date(`${hour}:00:00.000Z`));

class Tally {
  private readonly lines = new Map<string, UsageLine>();

  add(key: string, row: UsageRow, price: Price | null): UsageLine {
    let line = this.lines.get(key);
    if (!line) {
      line = emptyLine(key);
      this.lines.set(key, line);
    }
    line.calls += row.calls;
    if (row.long) line.longCalls += row.calls;
    line.tokens.input += row.input;
    line.tokens.cacheRead += row.cache_read;
    line.tokens.cacheWrite += row.cache_write + row.cache_write_1h;
    line.tokens.output += row.output;
    if (price) {
      line.cost = (line.cost ?? 0) + costOf(price, row);
      line.saved = (line.saved ?? 0) + (row.cache_read * (price.input - price.cacheRead)) / 1e6;
    } else line.unpricedTokens += tokensOf(row);
    return line;
  }

  // Most expensive first; lines with no price after, by tokens.
  sorted(): UsageLine[] {
    const total = (l: UsageLine) =>
      l.tokens.input + l.tokens.cacheRead + l.tokens.cacheWrite + l.tokens.output;
    return [...this.lines.values()].sort(
      (a, b) => (b.cost ?? -1) - (a.cost ?? -1) || total(b) - total(a),
    );
  }
}

// What one ticket (or all of them) spent on, and on which day.
class TicketTally {
  readonly models = new Tally();
  readonly skills = new Tally();
  readonly subagents = new Tally();
  readonly harnesses = new Tally();
  readonly daily: DailySeries;

  constructor(days: number) {
    this.daily = { cost: Array(days).fill(0), tokens: Array(days).fill(0) };
  }

  add(r: UsageRow, price: Price | null, day: number) {
    this.models.add(r.model, r, price);
    if (r.skill) this.skills.add(r.skill, r, price);
    if (r.agent) this.subagents.add(r.agent, r, price);
    this.harnesses.add(r.harness, r, price);
    if (price) this.daily.cost[day] = (this.daily.cost[day] ?? 0) + costOf(price, r);
    this.daily.tokens[day] = (this.daily.tokens[day] ?? 0) + tokensOf(r);
  }
}

export const MAX_SESSIONS = 100;
export const TICKET_SESSIONS = 20;

// Merges the sessions' open spans and adds their hours.
export function activeHoursOf(sessions: Pick<UsageSession, "first" | "last">[]): number {
  const spans = sessions
    .map((s) => [Date.parse(s.first), Date.parse(s.last)] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .sort((x, y) => x[0] - y[0]);
  let ms = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const [a, b] of spans) {
    if (b <= end) continue;
    ms += b - Math.max(a, end);
    end = b;
  }
  return ms / 3_600_000;
}

export function placesOf(db: Database, config: Config): Places {
  const places: Places = new Map();
  for (const p of db.query<PlaceRow, []>("SELECT id, cwd, branch FROM agent_places").all())
    places.set(p.id, { ...placeOf(config, p.cwd, p.branch), cwd: p.cwd, branch: p.branch });
  return places;
}

// The instants a report reads between: `from` included, `to` left out.
export type Cut = { from: string; to: string };

// The instants a range of local days covers: `to` is included whole.
const boundsOf = (from: string, to: string): Cut => ({
  from: new Date(`${from}T00:00:00`).toISOString(),
  to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString(),
});

function rowsBetween(db: Database, b: Cut): UsageRow[] {
  return db
    .query<UsageRow, [string, string]>(
      `SELECT harness, session_id, place_id, agent, role, effort, skill, model, ${LONG} AS long,
         substr(at, 1, 13) AS hour, count(*) AS calls, sum(input) AS input,
         sum(cache_read) AS cache_read, sum(cache_write) AS cache_write,
         sum(cache_write_1h) AS cache_write_1h, sum(output) AS output, min(at) AS first,
         max(at) AS last
       FROM agent_usage WHERE at >= ? AND at < ?
       GROUP BY harness, session_id, place_id, agent, role, effort, skill, model, long, hour`,
    )
    .all(b.from, b.to);
}

export function firstDayOf(db: Database): string | null {
  const row = db.query<{ at: string | null }, []>("SELECT min(at) AS at FROM agent_usage").get();
  return row?.at ? dayOf(new Date(row.at)) : null;
}

// Sessions filed under an objective (objectives/store.ts), keyed `<harness>:<session id>`.
export type Filed = Map<string, Objective>;

// The key a call's work is filed under: its session's objective (a ticket key or goal:<id>),
// else the ticket its folder and branch name; "" for none.
export const keyer =
  (places: Places, filed: Filed) =>
  (r: { harness: string; session_id: string; place_id: number }) => {
    const objective = filed.get(`${r.harness}:${r.session_id}`);
    return objective ? objectiveKey(objective) : (places.get(r.place_id)?.ticket ?? "");
  };

// The total and the tickets of a range, for another range to be read against.
function totalsOf(
  db: Database,
  config: Config,
  keyOf: ReturnType<typeof keyer>,
  from: string,
  to: string,
  b: Cut = boundsOf(from, to),
) {
  const total = new Tally();
  const tickets = new Tally();
  for (const r of rowsBetween(db, b)) {
    const price = priceOf(config.pricing, r.model, Boolean(r.long));
    total.add("total", r, price);
    tickets.add(keyOf(r), r, price);
  }
  return { from, to, total: total.sorted()[0] ?? emptyLine("total"), byTicket: tickets.sorted() };
}

// Days are local dates, inclusive: `to` covers that whole day. With no `from`, the range
// starts on the first day with a call and has nothing before it to compare with.
// Each `Bun.sleep(0)` lets the server answer other requests, terminal WebSockets among them:
// Bun serves on one thread, and the whole report read in one go held them ~100 ms.
// ponytail: the queries read between those pauses, so one part may count one ingest batch more
// than another until the next poll; move the report to a Worker with its own read-only
// connection if a mismatch shows or one query passes 50 ms.
export async function usageReport(
  db: Database,
  config: Config,
  // `cut`: exact instants inside those days, a quota week's, with `before` to compare against.
  range: { from?: string; to: string; cut?: Cut; before?: Cut },
  filed: Filed = new Map(),
): Promise<Omit<UsageReport, "ingest" | "router" | "logPose">> {
  const places = placesOf(db, config);
  const keyOf = keyer(places, filed);
  const firstDay = firstDayOf(db);
  const from = range.from ?? (firstDay && firstDay < range.to ? firstDay : range.to);
  const days = daysFrom(from, range.to);
  const index = new Map(days.map((d, i) => [d, i]));
  // ponytail: a time zone off UTC by a half hour splits an hour over two days; such an hour
  // counts on the nearer end of the range. Bucket by minute if the app moves to one.
  const dayIndex = (hour: string) => {
    const day = dayOfHour(hour);
    return index.get(day) ?? (day < from ? 0 : days.length - 1);
  };
  const b = range.cut ?? boundsOf(from, range.to);
  const rows = rowsBetween(db, b);

  const total = new Tally();
  const tickets = new Tally();
  const locations = new Tally();
  const models = new Tally();
  const skills = new Tally();
  const agents = new Tally();
  const roles = new Tally();
  const modelRoles = new Tally();
  const efforts = new Tally();
  const advised = new Set<string>();
  const claudeSessions = new Set<string>();
  // What each Claude model's tokens would have cost at every configured price, call by call,
  // so a long prompt keeps its long-prompt rate.
  const repriced = new Map<string, Record<string, number>>();
  const sessionTally = new Tally();
  const perTicket = new Map<string, TicketTally>();
  const ticketOf = (key: string) => {
    let t = perTicket.get(key);
    if (!t) {
      t = new TicketTally(days.length);
      perTicket.set(key, t);
    }
    return t;
  };
  const sessions = new Map<string, Omit<UsageSession, keyof UsageLine>>();
  const unpriced = new Set<string>();
  for (const r of rows) {
    const price = priceOf(config.pricing, r.model, Boolean(r.long));
    if (!price) unpriced.add(r.model);
    const place = places.get(r.place_id);
    const ticket = keyOf(r);
    const day = dayIndex(r.hour);
    total.add("total", r, price);
    tickets.add(ticket, r, price);
    locations.add(place?.location ?? "", r, price);
    models.add(r.model, r, price);
    if (r.skill) skills.add(r.skill, r, price);
    if (r.agent) agents.add(r.agent, r, price);
    const role = r.role === "advisor" ? "advisor" : r.agent ? "subagent" : "lead";
    roles.add(role, r, price);
    modelRoles.add(`${role}|${r.model}`, r, price);
    if (r.harness === "claude") claudeSessions.add(r.session_id);
    if (role === "advisor") advised.add(`${r.harness}:${r.session_id}`);
    else if (r.harness === "claude") efforts.add(r.effort, r, price);
    if (r.harness === "claude" && price) {
      const as = repriced.get(r.model) ?? {};
      for (const [key, p] of Object.entries(config.pricing))
        as[key] = (as[key] ?? 0) + costOf(r.long && p.over100k ? p.over100k : p, r);
      repriced.set(r.model, as);
    }
    ticketOf("*").add(r, price, day);
    ticketOf(ticket).add(r, price, day);
    const id = `${r.harness}:${r.session_id}`;
    sessionTally.add(id, r, price);
    const s = sessions.get(id);
    if (!s)
      sessions.set(id, {
        harness: r.harness,
        sessionId: r.session_id,
        ticket: ticket || null,
        location: place?.location ?? "",
        cwd: place?.cwd ?? "",
        branch: place?.branch ?? "",
        terminal: null,
        models: [r.model],
        first: r.first,
        last: r.last,
      });
    else {
      if (!s.models.includes(r.model)) s.models.push(r.model);
      if (r.first < s.first) s.first = r.first;
      if (r.last > s.last) {
        s.last = r.last;
        // The latest place is where the session is now.
        s.ticket = ticket || s.ticket;
        s.location = place?.location ?? s.location;
        s.cwd = place?.cwd ?? s.cwd;
        s.branch = place?.branch ?? s.branch;
      }
    }
  }
  await Bun.sleep(0);
  const names = new Map(
    db
      .query<{ session_id: string; name: string | null }, []>(
        "SELECT session_id, name FROM terminal_sessions WHERE session_id IS NOT NULL",
      )
      .all()
      .map((t) => [t.session_id, t.name]),
  );
  // Every session, most expensive first.
  const allSessions = sessionTally.sorted().flatMap((line) => {
    const s = sessions.get(line.key);
    return s ? [{ ...line, ...s, terminal: names.get(s.sessionId) ?? null }] : [];
  });
  const byTicketKey: Record<string, TicketUsage> = {};
  for (const [key, t] of perTicket) {
    const own = key === "*" ? allSessions : allSessions.filter((s) => (s.ticket ?? "") === key);
    byTicketKey[key] = {
      models: t.models.sorted(),
      skills: t.skills.sorted(),
      subagents: t.subagents.sorted(),
      harnesses: t.harnesses.sorted(),
      sessions: own.slice(0, TICKET_SESSIONS),
      sessionCount: own.length,
      first: own.reduce<string | null>((m, s) => (m && m < s.first ? m : s.first), null),
      last: own.reduce<string | null>((m, s) => (m && m > s.last ? m : s.last), null),
      activeHours: activeHoursOf(own),
      daily: t.daily,
    };
  }

  const events = db
    .query<EventRow, [string, string]>(
      `SELECT kind, name, detail, count(*) AS n FROM agent_events
       WHERE kind != 'hook' AND at >= ? AND at < ?
       GROUP BY kind, name, detail`,
    )
    .all(b.from, b.to);
  const counted = (kind: string) =>
    events
      .filter((e) => e.kind === kind)
      .map((e) => ({ name: e.name, detail: e.detail, count: e.n }))
      .sort((a, b) => b.count - a.count);
  const mcp = new Map<string, number>();
  for (const e of events)
    if (e.kind === "tool" && e.name.startsWith("mcp__")) {
      const server = e.name.split("__")[1] ?? e.name;
      mcp.set(server, (mcp.get(server) ?? 0) + e.n);
    }
  await Bun.sleep(0);
  const hooks = db
    .query<HookLine, [string, string]>(
      `SELECT name, sum(detail = 'ok') AS ok, sum(detail = 'block') AS block,
         sum(detail = 'error') AS error, sum(detail = 'timeout') AS timeout,
         CAST(round(avg(ms)) AS INTEGER) AS avgMs, max(ms) AS maxMs,
         coalesce(sum(ms), 0) AS totalMs
       FROM agent_events WHERE kind = 'hook' AND at >= ? AND at < ?
       GROUP BY name
       ORDER BY block + error + timeout DESC, ok DESC`,
    )
    .all(b.from, b.to);

  await Bun.sleep(0);
  const n = days.length;
  const start = new Date(`${from}T00:00:00`);
  const previous = range.before
    ? totalsOf(
        db,
        config,
        keyOf,
        dayOf(new Date(range.before.from)),
        dayOf(new Date(Date.parse(range.before.to) - 1)),
        range.before,
      )
    : range.from
      ? totalsOf(db, config, keyOf, daysBefore(start, n), daysBefore(start, 1))
      : null;
  await Bun.sleep(0);
  // The title of every goal the range's work is filed under.
  const goals: Record<string, string> = {};
  for (const o of filed.values())
    if (o.kind === "goal" && perTicket.has(objectiveKey(o)))
      goals[objectiveKey(o)] = objectiveLabel(o);
  return {
    from,
    to: range.to,
    firstDay,
    days,
    total: total.sorted()[0] ?? emptyLine("total"),
    byTicket: tickets.sorted(),
    byLocation: locations.sorted(),
    byModel: models.sorted(),
    bySkill: skills.sorted(),
    bySubagent: agents.sorted(),
    byRole: roles.sorted(),
    byModelRole: modelRoles.sorted(),
    byEffort: efforts.sorted(),
    advisorSessions: advised.size,
    claudeSessions: claudeSessions.size,
    repriced: Object.fromEntries(repriced),
    bySession: allSessions.slice(0, MAX_SESSIONS),
    tickets: byTicketKey,
    goals,
    previous,
    events: {
      skills: counted("skill"),
      commands: counted("command"),
      subagents: counted("subagent"),
      tools: counted("tool").filter((t) => !t.name.startsWith("mcp__")),
      mcp: [...mcp]
        .map(([name, count]) => ({ name, detail: "", count }))
        .sort((a, b) => b.count - a.count),
      hooks,
    },
    unpriced: [...unpriced].sort(),
  };
}
