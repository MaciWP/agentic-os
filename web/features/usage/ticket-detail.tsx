import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { relativeTime } from "../../format.ts";
import { StatusIcon } from "../tickets/icons.tsx";
import { DeltaText, harnessName, pct, share, widthOf } from "./charts.tsx";
import { CostCurve } from "./cost-curve.tsx";
import { Label, Stat, StatStrip } from "./kit.tsx";
import { ALL, amountOf, type TicketCost, type Unit } from "./ledger.ts";
import { dateText, type Ledger } from "./ledger-view.ts";
import { money, tokenText, totalTokens, type UsageLine } from "./queries.ts";

// Key, status and Jira title; all tickets, the work with no ticket and the keys Jira does not
// know say so. A title Jira could not give leaves only the key: the page says why above.
export function TicketName({ t, wrap }: { t: TicketCost; wrap?: boolean }) {
  if (t.key === ALL)
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="size-[14px] shrink-0 rounded-full bg-primary/30" />
        <span className="font-medium">Todos los tickets</span>
        <span className="truncate text-ink-2" title="con y sin ticket">
          con y sin ticket
        </span>
      </span>
    );
  if (!t.key)
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="size-[14px] shrink-0 rounded-full bg-warn/25" />
        <span className="font-medium text-warn">Sin ticket</span>
        <span className="truncate text-ink-2" title="ramas o carpetas sin clave">
          ramas o carpetas sin clave
        </span>
      </span>
    );
  if (t.goal !== undefined)
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="size-[14px] shrink-0 rounded-full border-2 border-primary/60"
        />
        <span
          className={cn("min-w-0 font-medium", wrap ? "line-clamp-2" : "truncate")}
          title={t.goal}
        >
          {t.goal}
        </span>
        <span className="shrink-0 text-ink-2">objetivo</span>
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-2">
      {t.jira ? (
        <StatusIcon status={t.jira.status.name} category={t.jira.status.category} />
      ) : (
        <span
          aria-hidden
          className="size-[14px] shrink-0 rounded-full border border-dashed border-ink-2/60"
        />
      )}
      <span className="shrink-0 font-mono text-[12.5px] whitespace-nowrap">{t.key}</span>
      {t.jira !== undefined && (
        <span
          className={cn("min-w-0", wrap ? "line-clamp-2" : "truncate", !t.jira && "text-warn")}
          title={t.jira?.title}
        >
          {t.jira ? t.jira.title : "Jira no encuentra esta clave"}
        </span>
      )}
    </span>
  );
}

// `whole`: the ledger is the whole history, not the period.
export function Head({ L, t, whole = false }: { L: Ledger; t: TicketCost; whole?: boolean }) {
  const context = [
    t.jira?.status.name,
    t.key !== ALL &&
      `${pct(share(t.amount, L.o.amount))} del consumo ${whole ? "de toda la historia" : "de este periodo"}`,
    t.usage.first &&
      `desde el ${new Date(t.usage.first).toLocaleDateString("es-ES", { day: "numeric", month: "long" })}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <header className="flex items-start justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h3 className="text-[18px] font-semibold">
          <TicketName t={t} wrap />
        </h3>
        <p className="text-[12px] text-ink-2">{context}</p>
      </div>
      <div className="flex shrink-0 items-start gap-5">
        <div className="flex flex-col items-end gap-1">
          <span className="text-[22px] leading-none font-semibold tracking-[-0.01em] tabular-nums">
            {L.fmt(t.amount)}
          </span>
          <DeltaText d={t.delta} className="text-[12px]" />
        </div>
        {t.key && t.key !== ALL && t.goal === undefined && (
          <Link to="/tickets/$key" params={{ key: t.key }} className="btn">
            Abrir ticket
          </Link>
        )}
      </div>
    </header>
  );
}

const SESSIONS_SHOWN = 10;

// Each session as a bar from its first call to its last, in its harness colour, across the
// span the ticket was worked on. The costliest ones, in the order they started.
function Timeline({ L, t, now }: { L: Ledger; t: TicketCost; now: number }) {
  const sessions = t.usage.sessions
    .slice(0, SESSIONS_SHOWN)
    .sort((a, b) => a.first.localeCompare(b.first));
  if (sessions.length === 0)
    return <p className="text-[12px] text-ink-2">Sin sesiones en este periodo.</p>;
  const a = Math.min(...sessions.map((s) => Date.parse(s.first)));
  const b = Math.max(...sessions.map((s) => Date.parse(s.last)), a + 3_600_000);
  const when = (ms: number) =>
    dateText(ms, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const rest = t.usage.sessionCount - sessions.length;
  return (
    <section aria-label="Sesiones" className="flex flex-col gap-1.5">
      <Label>
        Sesiones · {t.usage.sessionCount} ·{" "}
        {t.usage.activeHours.toLocaleString("es-ES", { maximumFractionDigits: 1 })} h activas
      </Label>
      <ul className="flex flex-col">
        {sessions.map((s) => {
          const from = (Date.parse(s.first) - a) / (b - a);
          const to = (Date.parse(s.last) - a) / (b - a);
          return (
            <li
              key={s.key}
              className="grid grid-cols-[150px_minmax(0,1fr)_112px] items-center gap-3 py-1 text-[12px]"
              title={`${s.sessionId}\n${s.cwd}\n${when(Date.parse(s.first))} → ${when(Date.parse(s.last))}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="harness-dot" data-harness={s.harness} />
                <span className="truncate">
                  {s.terminal ?? `${harnessName(s.harness)} ${s.sessionId.slice(-6)}`}
                </span>
              </span>
              <span className="relative h-2 rounded-full bg-[var(--hover)]/50">
                <span
                  className="absolute inset-y-0 rounded-full"
                  style={{
                    left: widthOf(from),
                    width: `max(4px, ${widthOf(to - from)})`,
                    background: `var(--h-${s.harness}, var(--ink-2))`,
                  }}
                />
              </span>
              <span className="text-right font-mono whitespace-nowrap tabular-nums">
                {L.fmt(amountOf(s, L.o.unit))}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="grid grid-cols-[150px_minmax(0,1fr)_112px] gap-3 text-[11px] text-ink-2">
        <span>{rest > 0 && `y ${rest} más pequeñas`}</span>
        <span className="flex justify-between">
          <span>{when(a)}</span>
          <span>{relativeTime(new Date(b).toISOString(), now)}</span>
        </span>
      </p>
    </section>
  );
}

function Ranked({ title, rows, unit }: { title: string; rows: UsageLine[]; unit: Unit }) {
  // Without a price on any row, tokens rank them rather than a column of zeros.
  const by: Unit = rows.some((l) => amountOf(l, unit) > 0) ? unit : "tokens";
  const max = Math.max(...rows.map((l) => amountOf(l, by)), 0);
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1.5">
      <Label>{title}</Label>
      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-2">Ninguno.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.slice(0, 5).map((l) => (
            <li key={l.key} className="flex flex-col gap-1 text-[12px]">
              <span className="flex justify-between gap-3">
                <span className="truncate font-mono" title={l.key}>
                  {l.key}
                </span>
                <span className="shrink-0 font-mono text-ink-2 tabular-nums">
                  {by === "money" ? money(l.cost) : tokenText(totalTokens(l))}
                </span>
              </span>
              <span
                aria-hidden
                className="block h-1 overflow-hidden rounded-full bg-[var(--hover)]"
              >
                <span
                  className="block h-full rounded-full bg-ink-2/60"
                  style={{ width: widthOf(share(amountOf(l, by), max)) }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Efficiency({ L, t }: { L: Ledger; t: TicketCost }) {
  const own = t.key !== ALL;
  const or = (x: number | null) => (x === null ? "—" : L.fmt(x));
  return (
    <StatStrip label="Eficiencia" cols={3}>
      <Stat
        label="Por hora activa"
        value={t.usage.activeHours > 0 ? L.fmt(t.amount / t.usage.activeHours) : "—"}
        sub={own && <span>media: {or(L.base.perHour)}</span>}
      />
      <Stat
        label="Leído de caché"
        value={pct(share(t.line.tokens.cacheRead, totalTokens(t.line)))}
        sub={own && <span>media: {pct(L.base.cache)}</span>}
      />
      <Stat
        label="Por llamada"
        value={t.line.calls > 0 ? L.fmt(t.amount / t.line.calls) : "—"}
        sub={own && <span>media: {or(L.base.perCall)}</span>}
      />
    </StatStrip>
  );
}

// The ticket's whole story; it lays itself out by the room it gets.
export function TicketDetail({ L, t, now }: { L: Ledger; t: TicketCost; now: number }) {
  return (
    <div className="@container flex min-w-0 flex-col gap-7">
      <div className="grid gap-7 @5xl:grid-cols-2">
        <CostCurve L={L} t={t} />
        <Timeline L={L} t={t} now={now} />
      </div>
      <div className="grid grid-cols-3 gap-5">
        <Ranked title="Modelos" rows={t.usage.models} unit={L.o.unit} />
        <Ranked title="Skills" rows={t.usage.skills} unit={L.o.unit} />
        <Ranked title="Subagentes" rows={t.usage.subagents} unit={L.o.unit} />
      </div>
      <Efficiency L={L} t={t} />
    </div>
  );
}
