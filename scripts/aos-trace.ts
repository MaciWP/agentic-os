// `aos trace`: the server's traces, read straight from `<data>/telemetry.db`, so it answers
// while the server is down too. Plain compact text by default, for an agent's context;
// `--json` for every field. The server is asked only to flush what it holds (`--flush`) and
// for its writer's counters (`status`).
import { existsSync } from "node:fs";
import { SpanKind } from "@opentelemetry/api";
import { DATA_DIR } from "../server/config-host.ts";
import { exclusive, GAP_MS, gaps, type Health, health, space } from "../server/telemetry/health.ts";
import {
  BUDGET_BYTES,
  errorGroups,
  openTelemetry,
  type RootRow,
  type SpanRow,
  STATUS_ERROR,
  since,
  slowest,
  summary,
  telemetryPath,
  traceOf,
  VERSION,
  versionOf,
} from "../server/telemetry/store.ts";

// Lines of a waterfall before the rest is summed up.
const MAX_LINES = 60;

export type TraceArgs = {
  sub: string;
  arg?: string;
  since?: string;
  vs?: string;
  by?: string;
  json?: boolean;
  flush?: boolean;
};
type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

export function parseSince(text: string | undefined, fallbackMs: number): number {
  if (text === undefined) return fallbackMs;
  const m = /^(\d+)(s|m|h|d)$/.exec(text);
  if (!m) throw new Error(`--since takes a span like 15m, 2h or 1d, not ${text}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

const ms = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
const clock = (at: number) => new Date(at).toLocaleTimeString("es-ES", { hour12: false });
// One line per finding: a multi-line provider message is folded and cut (--json has it whole).
const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export async function trace(
  a: TraceArgs,
  api: Api,
  out: (s: string) => void,
  dataDir = DATA_DIR,
  now = Date.now(),
): Promise<number> {
  if (a.sub === "full") {
    // While testing something: every request stored whole, for an hour unless told otherwise.
    const minutes = a.arg === "off" ? 0 : Number(a.arg ?? "60");
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)
      throw new Error("full takes minutes (1-1440) or off");
    const got = (await api("POST", "/api/telemetry/full", { minutes })) as {
      fullUntil?: number | null;
    };
    out(
      got.fullUntil
        ? `every request stored whole until ${clock(got.fullUntil)}`
        : "full tracing off",
    );
    return 0;
  }
  if (a.flush || a.sub === "status") {
    // The server holds up to a couple of seconds of spans; a reader that just caused one asks
    // for them. A server that is down holds nothing.
    const flushed = await api("POST", "/api/telemetry/flush", {}).catch(() => null);
    if (a.sub !== "status" && flushed === null)
      out("(server not reachable: reading the file as it is)");
  }
  const path = telemetryPath(dataDir, "server");
  if (!existsSync(path)) {
    out(`no traces yet: ${path} does not exist (TELEMETRY=off, or the server never ran with it)`);
    return 1;
  }
  const db = openTelemetry(path, true);
  try {
    // A server still on the older layout writes histograms this reader cannot sum.
    if ((a.sub === "slow" || a.sub === "health") && versionOf(db) < VERSION) {
      out(
        `${path} is still version ${versionOf(db)}: restart the server (it upgrades the file) for ${a.sub}`,
      );
      return 1;
    }
    const print = (data: unknown, text: () => string[]) =>
      out(a.json ? JSON.stringify(data, null, 2) : text().join("\n"));
    switch (a.sub) {
      case "errors": {
        const from = now - parseSince(a.since, 3_600_000);
        const groups = errorGroups(db, from);
        print(groups, () =>
          groups.length
            ? groups.map(
                (g) =>
                  `${g.count}× ${g.name} · ${oneLine(g.error)} · last ${clock(g.last)} · trace ${g.trace}`,
              )
            : [`no errors since ${clock(from)}`],
        );
        return 0;
      }
      case "slow": {
        const from = now - parseSince(a.since, 3_600_000);
        if (a.by !== undefined && a.by !== "total" && a.by !== "p95")
          throw new Error("--by takes total or p95");
        const byTotal = a.by === "total";
        const rows = slowest(db, from, 25, byTotal ? "total" : "p95");
        print(rows, () => {
          const line = (r: (typeof rows)[number]) =>
            `${r.key} · ${byTotal ? `${ms(r.total)} in all · ` : ""}p50 ${ms(r.p50)} p95 ${ms(r.p95)} max ${ms(r.max)} · ${r.n} calls${r.errors ? `, ${r.errors} failed` : ""}${r.trace ? ` · trace ${r.trace}` : ""}`;
          if (!rows.length) return [`nothing measured since ${clock(from)}`];
          const part = (title: string, metric: string) => {
            const some = rows.filter((r) => r.metric === metric);
            return some.length ? [title, ...some.map(line)] : [];
          };
          return [
            ...part(`requests (${byTotal ? "time in all" : "p95"}, worst first):`, "route"),
            ...part("outside calls and waits:", "op"),
            ...part("this process (event loop lateness per minute):", "process"),
          ];
        });
        return 0;
      }
      case "health": {
        const h = health(
          db,
          path,
          now,
          parseSince(a.since, 86_400_000),
          parseSince(a.vs, 7 * 86_400_000),
        );
        print(h, () => healthText(h));
        return 0;
      }
      case "since": {
        const cursor = Number(a.arg ?? "0");
        if (!Number.isInteger(cursor) || cursor < 0)
          throw new Error("since takes a whole number cursor");
        const got = since(db, cursor);
        print(got, () => [
          ...got.roots.map(
            (r) =>
              `${clock(r.start_ms)} ${r.name} ${ms(r.dur_ms)} ${r.status === STATUS_ERROR ? `ERROR ${oneLine(r.error ?? "")}` : "slow"} · trace ${r.trace_id}`,
          ),
          `cursor ${got.cursor}`,
        ]);
        return 0;
      }
      case "status": {
        const server = await api("GET", "/api/telemetry/status").catch((err: Error) => ({
          unreachable: err.message,
        }));
        const file = summary(db, path);
        const room = space(db, path, Date.now());
        print({ path, file, space: room, server }, () => [
          `${path}: ${file.roots} requests, ${file.spans} spans kept`,
          spaceLine(room),
          file.oldest
            ? `from ${new Date(file.oldest).toISOString()} to ${new Date(file.newest ?? 0).toISOString()}`
            : "empty",
          `server: ${JSON.stringify(server)}`,
        ]);
        return 0;
      }
      default: {
        const { root, spans } = traceOf(db, a.sub);
        if (!root && !spans.length) {
          out(
            `no trace or request ${a.sub} in ${path}: fast, correct reads and background runs are only counted (aos trace full stores every request)`,
          );
          return 1;
        }
        const rootName = db.query<{ name: string }, [string]>(
          "SELECT name FROM roots WHERE trace_id = ? LIMIT 1",
        );
        print({ root, spans: spans.map(expand) }, () =>
          waterfall(root, spans, (id) => rootName.get(id)?.name ?? null),
        );
        return 0;
      }
    }
  } finally {
    db.close();
  }
}

const expand = (s: SpanRow) => ({ ...s, attrs: JSON.parse(s.attrs), events: JSON.parse(s.events) });

// Same-name calls under one span that ran one after another (6 Jira pages, a repo at a time):
// each line looks fine, the sum is the cost, and the fix is often to run them together.
const SERIES_MIN = 3;
function series(children: SpanRow[]): { name: string; n: number; ms: number }[] {
  const out: { name: string; n: number; ms: number }[] = [];
  for (const [name, same] of Map.groupBy(children, (c) => c.name)) {
    if (same.length < SERIES_MIN) continue;
    const sorted = [...same].sort((a, b) => a.start_ms - b.start_ms);
    const apart = sorted.every(
      (c, i) =>
        i === 0 || c.start_ms >= (sorted[i - 1]?.start_ms ?? 0) + (sorted[i - 1]?.dur_ms ?? 0) - 1,
    );
    if (apart) out.push({ name, n: same.length, ms: same.reduce((t, c) => t + c.dur_ms, 0) });
  }
  return out;
}

// `rootName` names another stored trace (the load a `cache wait` joined), or null.
export function waterfall(
  root: RootRow | null,
  spans: SpanRow[],
  rootName: (traceId: string) => string | null = () => null,
): string[] {
  const lines: string[] = [];
  if (root) {
    const why = root.kept || "not sampled: only this line was stored";
    lines.push(
      `${root.name} · ${ms(root.dur_ms)} · ${root.status === STATUS_ERROR ? `ERROR ${oneLine(root.error ?? "")}` : "ok"} · ${why} · ${new Date(root.start_ms).toISOString()}`,
    );
    lines.push(`trace ${root.trace_id}${root.request_id ? ` · request ${root.request_id}` : ""}`);
  }
  if (!spans.length) return lines;
  const ids = new Set(spans.map((s) => s.span_id));
  const kids = new Map<string, SpanRow[]>();
  for (const s of spans) {
    const parent = s.parent_id && ids.has(s.parent_id) ? s.parent_id : "";
    kids.set(parent, [...(kids.get(parent) ?? []), s]);
  }
  // A parent from another process that was not stored (the PC's part, the browser's).
  const orphans = spans.filter((s) => s.parent_id && !ids.has(s.parent_id) && !s.local_root);
  const t0 = Math.min(...spans.map((s) => s.start_ms));
  const rows: { depth: number; s: SpanRow; self: number; children: SpanRow[] }[] = [];
  const walk = (s: SpanRow, depth: number) => {
    const children = kids.get(s.span_id) ?? [];
    rows.push({ depth, s, self: exclusive(s, children), children });
    for (const c of children) walk(c, depth + 1);
  };
  for (const s of kids.get("") ?? []) walk(s, 0);
  // Past the cap, errors and the slowest stay: they are what a reader came for.
  const shown =
    rows.length <= MAX_LINES
      ? rows
      : (() => {
          const keep = new Set(
            [...rows]
              .sort(
                (x, y) =>
                  Number(y.s.status === STATUS_ERROR) - Number(x.s.status === STATUS_ERROR) ||
                  y.self - x.self,
              )
              .slice(0, MAX_LINES),
          );
          return rows.filter((r) => keep.has(r));
        })();
  for (const { depth, s, self, children } of shown) {
    const flag = s.status === STATUS_ERROR ? ` ERROR${s.error ? ` ${oneLine(s.error)}` : ""}` : "";
    const own = self < s.dur_ms - 0.5 ? ` (self ${ms(self)})` : "";
    lines.push(
      `${"  ".repeat(depth)}+${ms(s.start_ms - t0)} ${ms(s.dur_ms)}${own} ${s.name}${s.proc === "server" ? "" : ` [${s.proc}]`}${flag}`,
    );
    const note = (text: string) => lines.push(`${"  ".repeat(depth + 1)}· ${text}`);
    for (const e of JSON.parse(s.events) as {
      name: string;
      at_ms: number;
      [k: string]: unknown;
    }[]) {
      const { name, at_ms: at, level, scope, msg, ...rest } = e;
      const fields = Object.entries(rest)
        .filter(([k]) => k !== "stack")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ");
      const text = name === "log" ? `${String(level).toUpperCase()} ${scope}: ${msg}` : name;
      note(`+${ms(at)} ${text}${fields ? ` ${fields}` : ""}`);
    }
    const joined = (JSON.parse(s.attrs) as Record<string, unknown>)["joined.trace"];
    if (typeof joined === "string" && joined)
      note(
        `waited on ${rootName(joined) ?? "a load whose trace was not stored"} · trace ${joined}`,
      );
    // Time under no span is a wait nobody instrumented; a leaf call's time is its own work.
    if (children.length || s.kind === SpanKind.SERVER)
      for (const [from, to] of gaps(s, children))
        if (to - from >= GAP_MS)
          note(`+${ms(from - s.start_ms)} ${ms(to - from)} with no span: not instrumented`);
    for (const run of series(children))
      note(`${run.n}× ${run.name} one after another: ${ms(run.ms)} in all`);
  }
  if (shown.length < rows.length)
    lines.push(
      `… ${rows.length - shown.length} more spans (errors and the slowest are shown; --json for all)`,
    );
  if (orphans.length)
    lines.push(`(${orphans.length} spans whose parent was not stored in this file)`);
  return lines;
}

const days = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} d`;

export function healthText(h: ReturnType<typeof health>): string[] {
  const out: string[] = [];
  const base = `baseline ${days(h.base.days)} of data in the ${days(h.base.wanted)} before ${clock(h.from)}`;
  out.push(`since ${new Date(h.from).toISOString()} · ${base}`);
  out.push(
    h.errorBase < 1
      ? `new errors (stored requests cover ${days(h.errorBase)} of the baseline: most read as new):`
      : "new errors (not seen in the baseline):",
  );
  out.push(
    ...(h.newErrors.length
      ? h.newErrors.map(
          (g) => `  ${g.count}× ${g.name} · ${oneLine(g.error, 120)} · trace ${g.trace}`,
        )
      : ["  none"]),
  );
  out.push("regressions (p95 up 30 % and 100 ms, 20+ calls each side):");
  if (h.regressions.length)
    out.push(
      ...h.regressions.map(
        (r) => `  ${r.key} · p95 ${ms(r.base)} → ${ms(r.now)} · ${r.nBase} → ${r.nNow} calls`,
      ),
    );
  // Never "none" on a baseline too short to compare against.
  else out.push(h.base.enough ? "  none" : "  not judged: baseline under a day");
  out.push("where the time goes (sum of durations):");
  out.push(...h.heaviest.map((x) => `  ${x.key} · ${ms(x.total)} in ${x.n} calls`));
  out.push(`waits with no span (≥ ${GAP_MS} ms, worst trace per route):`);
  out.push(
    ...(h.blind.length
      ? h.blind.map((b) => `  ${b.name} · ${ms(b.blind)} of ${ms(b.dur)} · trace ${b.trace}`)
      : ["  none in the stored slow and failed requests"]),
  );
  out.push(
    h.loop
      ? `event loop: lateness p99 ${ms(h.loop.p99)} in a usual minute, worst ${ms(h.loop.worst)}`
      : "event loop: not measured yet",
  );
  out.push(spaceLine(h.space));
  return out;
}

function spaceLine({ bytes, perDay, steady }: Health["space"]): string {
  const settles =
    steady === null
      ? "pace known half an hour after a start"
      : steady > BUDGET_BYTES
        ? `settles near ${mib(steady)}, over the ${mib(BUDGET_BYTES)} budget: the oldest evidence will be cut first`
        : `settles near ${mib(steady)} of the ${mib(BUDGET_BYTES)} budget`;
  return `space: ${mib(bytes)}${perDay !== null ? ` · ${mib(perDay)} a day` : ""} · ${settles}`;
}
