import { type ReactNode, useState } from "react";
import type { Coverage } from "../../../server/features/usage/types.ts";
import { ISSUE_KEY } from "../../../shared/envs.ts";
import { ErrorState, SkeletonRows, StaleNotice } from "../../ui.tsx";
import { BarList, DeltaText, harnessName, PCT0, pct, share, widthOf } from "./charts.tsx";
import { Box, Label, Section, Stat, StatStrip, Table } from "./kit.tsx";
import { deltaOf } from "./ledger.ts";
import { type ChartSeries, PeriodChart, QuotaStrip } from "./period-chart.tsx";
import {
  type ColorBy,
  colorOf,
  cumulative,
  type Filters,
  filtered,
  filteredHistory,
  heatOf,
  OTHER,
  type Pace,
  paceOf,
  type Scope,
  seriesLabel,
  seriesOf,
  slotsOf,
  stackOf,
  totalsBy,
  type Unit,
  unpricedTokens,
} from "./period-view.ts";
import {
  money,
  type PeriodPick,
  tokenText,
  type UsagePeriod,
  useJiraBriefs,
  usePeriod,
} from "./queries.ts";
import { TARGETS } from "./targets.ts";

// «Cómo vamos»: the quota week (or a month) hour by hour, coloured by where the spend comes
// from, against the period before, with the pace carried to its end, the plan's quota on the
// same clock and how much of Claude Code's own count the transcripts hold.

const SCOPES: [Scope, string][] = [
  ["all", "Total"],
  ["ticket", "Con ticket"],
  ["none", "Sin ticket"],
];
const COLOR_BY: [ColorBy, string][] = [
  ["origin", "Origen"],
  ["project", "Proyecto"],
  ["model", "Modelo"],
  ["harness", "Harness"],
];
const UNITS: [Unit, string][] = [
  ["money", "US$"],
  ["tokens", "Tokens"],
];
const SHOWN = 12;
const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];

const fmtOf = (unit: Unit) => (n: number) =>
  unit === "money" ? money(n) : `${tokenText(Math.round(n))} tokens`;

function periodTitle(p: UsagePeriod): string {
  const start = new Date(p.start);
  if (p.kind === "month")
    return start.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  return `${start.toLocaleString("es-ES", opts)} → ${new Date(p.end).toLocaleString("es-ES", opts)}`;
}

const ANCHOR: Record<UsagePeriod["anchor"], string> = {
  plan: "la semana de la cuota de Claude",
  sample: "la semana de la cuota, según la última muestra guardada",
  monday: "de lunes a lunes: no hay lectura de la cuota",
  month: "el mes natural",
};

// A group of pressed-or-not buttons, the Agentes «Vista» way.
function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">{label}</legend>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          className="nav-item"
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  );
}

// The period is the page's: the sections below read the same one.
export function PeriodPanel({
  pick,
  onPick,
  onTicket,
}: {
  pick: PeriodPick;
  onPick: (next: PeriodPick) => void;
  onTicket: (key: string) => void;
}) {
  const { kind, offset } = pick;
  const [f, setF] = useState<Filters>({
    scope: "all",
    hidden: new Set(),
    colorBy: "origin",
    unit: "money",
    focus: null,
  });
  const q = usePeriod(kind, offset);
  const p = q.data;
  const set = (patch: Partial<Filters>) => setF((old) => ({ ...old, ...patch }));
  const noun = kind === "week" ? "Semana" : "Mes";
  return (
    <Section
      id="usage-period"
      title={kind === "week" ? "Semana de cuota" : "Mes"}
      hint={p ? `${periodTitle(p)} · ${offset === 0 ? "en curso" : "cerrado"}` : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Choice
          label="Periodo"
          options={[
            ["week", "Semana"],
            ["month", "Mes"],
          ]}
          value={kind}
          onChange={(k) => onPick({ kind: k, offset: 0 })}
        />
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="btn"
            aria-label={`${noun} anterior`}
            title={`${noun} anterior`}
            onClick={() => onPick({ kind, offset: offset + 1 })}
          >
            ‹
          </button>
          <button
            type="button"
            className="btn"
            aria-label={`${noun} siguiente`}
            title={`${noun} siguiente`}
            disabled={offset === 0}
            onClick={() => onPick({ kind, offset: Math.max(0, offset - 1) })}
          >
            ›
          </button>
          {offset > 0 && (
            <button
              type="button"
              className="btn-ghost px-2"
              onClick={() => onPick({ kind, offset: 0 })}
            >
              Volver a {kind === "week" ? "la actual" : "el actual"}
            </button>
          )}
        </span>
        <Choice
          label="Alcance"
          options={SCOPES}
          value={f.scope}
          onChange={(scope) => set({ scope })}
        />
        {p && <HarnessChips p={p} hidden={f.hidden} onChange={(hidden) => set({ hidden })} />}
        <label className="flex items-center gap-2 text-[12px] text-ink-2">
          Colorear por
          <select
            className="btn"
            value={f.colorBy}
            onChange={(e) => set({ colorBy: e.target.value as ColorBy, focus: null })}
          >
            {COLOR_BY.map(([v, text]) => (
              <option key={v} value={v}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <Choice label="Unidad" options={UNITS} value={f.unit} onChange={(unit) => set({ unit })} />
      </div>
      {q.isPending ? (
        <SkeletonRows count={6} />
      ) : q.isError && !p ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : p ? (
        <>
          {q.isError && <StaleNotice error={q.error} onRetry={() => q.refetch()} />}
          <PeriodBody p={p} f={f} set={set} onTicket={onTicket} />
        </>
      ) : null}
    </Section>
  );
}

function HarnessChips({
  p,
  hidden,
  onChange,
}: {
  p: UsagePeriod;
  hidden: Set<string>;
  onChange: (hidden: Set<string>) => void;
}) {
  const present = [...new Set([...p.rows, ...p.previous.rows].map((r) => r.harness))].sort();
  if (present.length < 2) return null;
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">Harness</legend>
      {present.map((h) => (
        <button
          key={h}
          type="button"
          aria-pressed={!hidden.has(h)}
          className="nav-item"
          onClick={() => {
            const next = new Set(hidden);
            if (next.has(h)) next.delete(h);
            else next.add(h);
            // Never all off: the chart would say nothing.
            if (next.size < present.length) onChange(next);
          }}
        >
          <span aria-hidden className="harness-dot mr-1.5" data-harness={h} />
          {harnessName(h)}
        </button>
      ))}
    </fieldset>
  );
}

function PeriodBody({
  p,
  f,
  set,
  onTicket,
}: {
  p: UsagePeriod;
  f: Filters;
  set: (patch: Partial<Filters>) => void;
  onTicket: (key: string) => void;
}) {
  const [table, setTable] = useState(false);
  const fmt = fmtOf(f.unit);
  const rows = filtered(p.rows, f);
  const before = filtered(p.previous.rows, f);
  // Every series of the period, not only the shown ones, for the colours and «De dónde sale».
  const unfocused = filtered(p.rows, { ...f, focus: null });
  const slots = slotsOf(p.rows, f.colorBy);
  const tickets = [...new Set(p.rows.map((r) => r.ticket).filter((t) => ISSUE_KEY.test(t)))];
  const briefs = useJiraBriefs(tickets).data;
  const titles = briefs && "briefs" in briefs ? briefs.briefs : {};
  const labelOf = (key: string) => seriesLabel(key, p.goals);
  const textOf = (key: string) => {
    const t = key.startsWith("t:") ? titles[key.slice(2)]?.title : undefined;
    return t ? `${labelOf(key)} · ${t}` : labelOf(key);
  };
  const series: ChartSeries[] = stackOf(rows, p.hours, f, slots).map((s) => ({
    ...s,
    label: labelOf(s.key),
    color: colorOf(s.key, slots, f.colorBy),
  }));
  const cum = cumulative(rows, p.hours, f.unit);
  const previous = cumulative(before, p.previous.hours, f.unit);
  const history = f.focus ? null : filteredHistory(p.history?.rows ?? [], f);
  const pace = paceOf(p, cum, previous, history, f.unit);
  const unpriced = f.unit === "money" ? unpricedTokens(rows) : 0;
  const sources = totalsBy(unfocused, (r) => seriesOf(r, f.colorBy), f.unit);
  const whole = sources.reduce((n, [, v]) => n + v, 0);
  return (
    <div className="flex flex-col gap-6">
      <StatStrip label={p.kind === "week" ? "La semana en cifras" : "El mes en cifras"}>
        <Stat
          label={p.offset === 0 ? "Gastado hasta ahora" : "Gastado"}
          value={fmt(pace.spent)}
          sub={
            <>
              <span>
                {pace.before === null
                  ? "sin datos del periodo anterior"
                  : `${fmt(pace.before)} en el mismo tramo anterior`}{" "}
                <DeltaText
                  d={deltaOf(pace.spent, pace.before)}
                  against="Frente al mismo tramo del periodo anterior"
                />
              </span>
              {unpriced > 0 && <span>sin precio: {tokenText(unpriced)} tokens</span>}
            </>
          }
        />
        <Stat
          label="Ritmo"
          value={pace.perHour === null ? "—" : `${fmt(pace.perHour)}/h`}
          sub={<RhythmText p={p} pace={pace} fmt={fmt} />}
        />
        <Stat
          label={p.offset === 0 ? "Proyección al cierre" : "Periodo anterior"}
          value={
            p.offset === 0
              ? pace.projected === null
                ? "—"
                : fmt(pace.projected)
              : fmt(previous.at(-1) ?? 0)
          }
          sub={
            p.offset === 0
              ? f.focus
                ? "sin proyección de una sola serie"
                : pace.projected === null
                  ? "pocas horas para proyectar"
                  : `${
                      pace.basis === "profile"
                        ? `con la forma de tus ${pace.weeks} semanas anteriores, entre ${fmt(pace.path.low.at(-1) ?? 0)} y ${fmt(pace.path.high.at(-1) ?? 0)}`
                        : "al ritmo de las últimas 24 h: aún no hay 2 semanas anteriores con gasto"
                    }; el anterior acabó en ${fmt(previous.at(-1) ?? 0)}`
              : "entero, para comparar"
          }
        />
        <CoverageStat c={p.coverage} />
      </StatStrip>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2">
          {series.map((s) => (
            <span key={s.key} className="flex max-w-56 items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: s.color }}
              />
              <span className="truncate" title={textOf(s.key)}>
                {s.label}
              </span>
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-3 border-t border-dashed border-ink-2" />
            periodo anterior
          </span>
          {pace.projected !== null && !f.focus && (
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block w-3 border-t border-dashed border-ink" />
              proyección{pace.basis === "profile" ? " y su margen" : ""}
            </span>
          )}
          <button
            type="button"
            className="btn-ghost ml-auto px-2"
            aria-pressed={table}
            onClick={() => setTable((t) => !t)}
          >
            {table ? "Ver como gráfico" : "Ver como tabla"}
          </button>
        </div>
        {series.length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-4 py-6 text-[12px] text-ink-2">
            Nada gastado en este periodo con estos filtros.
          </p>
        ) : table ? (
          <Box>
            <Table
              label="Gasto por serie"
              rows={series}
              rowKey={(s) => s.key}
              empty=""
              cols={[
                { head: "Serie", cell: (s) => s.label, title: (s) => textOf(s.key) },
                { head: "Importe", num: true, cell: (s) => fmt(s.total) },
                { head: "Parte", num: true, cell: (s) => pct(share(s.total, pace.spent)) },
              ]}
            />
          </Box>
        ) : (
          <PeriodChart
            label="Gasto acumulado por hora"
            series={series}
            hours={p.hours}
            elapsed={p.elapsed}
            start={Date.parse(p.start)}
            previous={previous}
            path={f.focus ? { mid: [], low: [], high: [] } : pace.path}
            fmt={fmt}
          />
        )}
        <Quota p={p} spentClaude={claudeMoney(p)} />
        <p className="text-[11px] text-ink-2">
          {ANCHOR[p.anchor]} · solo este Mac
          {f.focus && (
            <>
              {" "}
              · solo {labelOf(f.focus)}{" "}
              <button type="button" className="btn-ghost px-1" onClick={() => set({ focus: null })}>
                Quitar
              </button>
            </>
          )}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <Label>De dónde sale · pulsa uno para verlo solo</Label>
          <Box>
            <BarList
              label="De dónde sale"
              empty="Nada gastado con estos filtros."
              picked={f.focus}
              onPick={(key) => set({ focus: f.focus === key ? null : key })}
              bars={sources.slice(0, SHOWN).map(([key, v]) => ({
                key,
                label: labelOf(key),
                text: textOf(key),
                value: v,
                valueText: `${fmt(v)} · ${PCT0.format(share(v, whole))}`,
                color: colorOf(
                  slots.has(key) || f.colorBy === "harness" ? key : OTHER,
                  slots,
                  f.colorBy,
                ),
              }))}
            />
            {sources.length > SHOWN && (
              <p className="border-t border-line px-3 py-1.5 text-[12px] text-ink-2">
                Y {sources.length - SHOWN} más:{" "}
                {fmt(sources.slice(SHOWN).reduce((n, [, v]) => n + v, 0))}.
              </p>
            )}
          </Box>
          {f.focus?.startsWith("t:") && ISSUE_KEY.test(f.focus.slice(2)) && (
            <button
              type="button"
              className="btn self-start"
              onClick={() => onTicket(f.focus?.slice(2) ?? "")}
            >
              Ver la historia de {f.focus.slice(2)}
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Heatmap grid={heatOf(rows, p.start, f.unit)} fmt={fmt} />
          <Models p={p} rows={rows} unit={f.unit} fmt={fmt} />
        </div>
      </div>
    </div>
  );
}

// The last 24 hours against the same hours of the week in the weeks before.
function RhythmText({ p, pace, fmt }: { p: UsagePeriod; pace: Pace; fmt: (n: number) => string }) {
  const hours = Math.min(24, p.elapsed);
  if (pace.perHour === null || p.offset > 0) return <span>en sus últimas {hours} h</span>;
  if (!pace.normalDay) return <span>en las últimas {hours} h</span>;
  const d = deltaOf(pace.perHour * hours, pace.normalDay);
  return (
    <span>
      en las últimas {hours} h; lo normal a estas horas, {fmt(pace.normalDay / hours)}/h{" "}
      <DeltaText d={d} against="Frente a las mismas horas de la semana en las semanas anteriores" />
    </span>
  );
}

// Claude's money in the period, every filter off: what one percent of its quota is set against.
const claudeMoney = (p: UsagePeriod) =>
  p.rows.reduce((n, r) => n + (r.harness === "claude" ? (r.cost ?? 0) : 0), 0);

function Quota({ p, spentClaude }: { p: UsagePeriod; spentClaude: number }) {
  const weekly = p.quota.filter((s) => s.harness === "claude" && s.minutes === 10_080).at(-1);
  if (p.quota.length === 0)
    return (
      <p className="text-[12px] text-ink-2">
        Sin muestras de la cuota en este periodo: el servidor las guarda cada 5 minutos desde que se
        reinicia con esta versión.
      </p>
    );
  return (
    <div className="flex flex-col gap-1">
      <Label>
        Cuota del plan
        {p.kind === "week" && weekly?.percent ? (
          <span title="El gasto es el de este Mac; la cuota es la de toda la cuenta (claude.ai, el móvil, el PC)">
            {" "}
            · ≈ {money(spentClaude / weekly.percent)} de este Mac por cada 1 %
          </span>
        ) : null}
      </Label>
      <QuotaStrip
        samples={p.quota}
        start={Date.parse(p.start)}
        hours={p.hours}
        elapsed={p.elapsed}
      />
    </div>
  );
}

function CoverageStat({ c }: { c: Coverage | null }) {
  if (!c || c.harnessUsd <= 0)
    return (
      <Stat
        label="Cobertura frente a Claude Code"
        value="sin dato"
        sub="ninguna sesión de este periodo trae aún su propio contador"
      />
    );
  const inside = c.harnessUsd - c.outsideUsd;
  return (
    <Stat
      label="Cobertura frente a Claude Code"
      value={pct(c.oursUsd / c.harnessUsd)}
      goal={{ value: c.oursUsd / c.harnessUsd, target: TARGETS.coverage }}
      why="si baja, la ingesta pierde llamadas y todo el gasto se queda corto"
      title="Nuestro coste de cada sesión frente al contador que Claude Code escribe en su transcript"
      sub={
        <>
          <span>
            {c.sessions} sesiones de este Mac · fuera del transcript {money(c.outsideUsd)}
          </span>
          {c.late > 0 && <span>{c.late} con contador tardío, aparte</span>}
        </>
      }
      chart={
        <span
          className="flex h-1.5 overflow-hidden rounded-full bg-[var(--hover)]"
          title={`En el transcript ${money(inside)} · fuera ${money(c.outsideUsd)}`}
        >
          <span
            style={{ width: widthOf(share(inside, c.harnessUsd)), background: "var(--cat-1)" }}
          />
          <span
            style={{
              width: widthOf(share(c.outsideUsd, c.harnessUsd)),
              background: "var(--cat-4)",
            }}
          />
        </span>
      }
    />
  );
}

// Local weekday by hour: one hue, darker where more was spent.
function Heatmap({ grid, fmt }: { grid: number[][]; fmt: (n: number) => string }) {
  const max = Math.max(...grid.flat(), 0);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label>Cuándo gastas · día y hora local</Label>
      <div className="grid grid-cols-[1rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px] text-ink-2">
        {grid.map((day, d) => (
          <Row key={WEEKDAYS[d]} name={WEEKDAYS[d] ?? ""}>
            {day.map((v, h) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the hour is the cell
                key={h}
                className="aspect-square rounded-[2px]"
                title={`${WEEKDAYS[d]} ${h}:00–${h + 1}:00: ${fmt(v)}`}
                style={{
                  background:
                    v > 0
                      ? `color-mix(in oklab, var(--cat-1) ${Math.round(15 + 85 * share(v, max))}%, var(--panel))`
                      : "var(--panel)",
                }}
              />
            ))}
          </Row>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the hour is the label
          <span key={h} className="text-center">
            {h % 6 === 0 ? h : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const Row = ({ name, children }: { name: string; children: ReactNode }) => (
  <>
    <span className="self-center">{name}</span>
    {children}
  </>
);

// Each model's share as one bar, in the model colours the chart uses.
function Models({
  p,
  rows,
  unit,
  fmt,
}: {
  p: UsagePeriod;
  rows: UsagePeriod["rows"];
  unit: Unit;
  fmt: (n: number) => string;
}) {
  const slots = slotsOf(p.rows, "model");
  const models = totalsBy(rows, (r) => `m:${r.model}`, unit);
  const total = models.reduce((n, [, v]) => n + v, 0);
  if (total <= 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label>Modelos</Label>
      <span className="flex h-3 gap-[2px] overflow-hidden rounded-[4px]">
        {models.map(([key, v]) => (
          <span
            key={key}
            title={`${key.slice(2)}: ${fmt(v)} · ${pct(share(v, total))}`}
            style={{ width: widthOf(share(v, total)), background: colorOf(key, slots, "model") }}
          />
        ))}
      </span>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2">
        {models.slice(0, 6).map(([key, v]) => (
          <li key={key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-[2px]"
              style={{ background: colorOf(key, slots, "model") }}
            />
            <span className="font-mono">{key.slice(2)}</span> {PCT0.format(share(v, total))}
          </li>
        ))}
      </ul>
    </div>
  );
}
