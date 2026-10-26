import type { RouterReport, RouterWeek } from "../../../server/features/usage/router.ts";
import { plural } from "../../format.ts";
import { BarList, pct, share, widthOf } from "./charts.tsx";
import { Panel, Section, Stat, StatStrip, Table } from "./kit.tsx";
import { TARGETS } from "./targets.ts";

// Does Poneglyph's prompt router work: do its suggestions get loaded, does it miss what the
// session needed, does its note arrive while the turn still reads it, and does it answer. Read
// from its logs (the hook's and Log Pose's) and the sessions' skill loads and tool calls.

const of = (part: number, whole: number) => (whole > 0 ? pct(share(part, whole)) : "—");
const weekText = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString("es-ES", { day: "numeric", month: "short" });

// Weeks from the first one the router ran, up to the period's.
export const trendOf = (r: RouterReport) => {
  const first = r.trend.findIndex((w) => w.runs > 0);
  return first < 0 ? [] : r.trend.slice(first);
};

const share0 = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function Router({ r }: { r: RouterReport | null }) {
  return (
    <Section
      id="usage-router"
      title="Router de skills"
      hint="¿sus sugerencias sirven? Lee cada prompt, sugiere skills y corrige el dictado"
    >
      {r === null || (r.runs === 0 && r.errors.length === 0) ? (
        <p className="max-w-[90ch] text-[12px] text-ink-2">
          El router no ha leído ningún prompt en este periodo.
        </p>
      ) : (
        <RouterBody r={r} />
      )}
    </Section>
  );
}

function RouterBody({ r }: { r: RouterReport }) {
  const weeks = trendOf(r);
  return (
    <>
      <StatStrip label="El router en este periodo" cols={3}>
        <Stat
          label="Acierto · ¿sus sugerencias se usan?"
          value={of(r.accepted, r.suggested)}
          goal={{ value: share0(r.accepted, r.suggested), target: TARGETS.accepted }}
          why="si baja, revisar la rúbrica o el catálogo de skills"
          sub={
            <>
              <span>
                {r.accepted} de {r.suggested} sugerencias se cargaron antes del siguiente prompt
              </span>
              {r.early > 0 && <span>{r.early} ya las había cargado el modelo por su cuenta</span>}
            </>
          }
        />
        <Stat
          label="Se le escapan · ¿qué no sugiere?"
          value={of(r.missed, r.loads)}
          goal={{ value: share0(r.missed, r.loads), target: TARGETS.missed }}
          why="qué skills añadir al catálogo o a su memoria"
          sub={
            <span>
              {r.missed} de {r.loads} skills cargadas en un turno que leyó, sin sugerirlas
            </span>
          }
        />
        <Stat
          label="Llega a tiempo · ¿la nota llega con el turno vivo?"
          value={of(r.delivered, r.notes)}
          goal={{ value: share0(r.delivered, r.notes), target: TARGETS.delivered }}
          why="una nota que llega tarde no la lee nadie"
          sub={
            <span>
              {r.delivered} de {r.notes} notas llegaron con el turno vivo: las del hook, con una
              herramienta detrás; las de Log Pose, al responder antes de empezar
            </span>
          }
        />
      </StatStrip>
      <div className="grid gap-x-12 gap-y-12 lg:grid-cols-2">
        <Panel
          title="Sugerida → cargada"
          question="¿qué skills sugiere mal?"
          why="qué skill reescribir o quitar del catálogo del router"
          rows={r.bySkill.length}
          chart={(n) => <SkillRatio rows={r.bySkill.slice(0, n)} />}
          table={(n) => (
            <Table
              label="Sugerida → cargada"
              rows={r.bySkill.slice(0, n)}
              rowKey={(s) => s.name}
              empty="Ninguna sugerencia en este periodo."
              cols={[
                { head: "Skill", cell: (s) => <span className="font-mono">{s.name}</span> },
                { head: "Sugerida", num: true, cell: (s) => s.suggested },
                { head: "Cargada", num: true, cell: (s) => s.accepted },
                { head: "Acierto", num: true, cell: (s) => of(s.accepted, s.suggested) },
              ]}
            />
          )}
        />
        <Panel
          title="Se le escapan"
          question="¿qué cargó la sesión sin que la sugiriera?"
          why="qué skill añadir al catálogo del router o a su memoria"
          rows={r.missedTop.length}
          chart={(n) => (
            <BarList
              label="Se le escapan"
              empty="Nada: cada skill cargada estaba sugerida."
              bars={r.missedTop.slice(0, n).map((m) => ({
                key: m.name,
                label: <span className="font-mono">{m.name}</span>,
                text: m.name,
                value: m.count,
                valueText: String(m.count),
              }))}
            />
          )}
        />
        <Panel
          title="Semana a semana"
          question="¿mejora? Acierto y notas a tiempo, de lunes a domingo"
          why="ver si un cambio del router o de Log Pose mejoró o empeoró las cifras"
          rows={weeks.length}
          chart={() => <Trend weeks={weeks} />}
          table={() => (
            <Table
              label="Semana a semana"
              rows={weeks}
              rowKey={(w) => w.week}
              empty="Sin semanas con el router."
              cols={[
                { head: "Semana", cell: (w) => weekText(w.week) },
                { head: "Prompts", num: true, cell: (w) => w.runs },
                { head: "Con Log Pose", num: true, cell: (w) => w.mod },
                { head: "Acierto", num: true, cell: (w) => of(w.accepted, w.suggested) },
                { head: "A tiempo", num: true, cell: (w) => of(w.delivered, w.notes) },
              ]}
            />
          )}
        />
      </div>
      <p className="max-w-[90ch] text-[12px] text-ink-2">
        Una sugerencia cuenta si la sesión la carga en los 30 minutos siguientes, antes del próximo
        prompt.{" "}
        {r.agentRuns > 0 &&
          `${plural(r.agentRuns, "vez", "veces")} lo lanzó el modelo como subagente: ese gasto va en Subagentes. `}
        {r.unjoined > 0 && `${r.unjoined} prompts sin sesión identificable, fuera del acierto. `}
        Si el router falla o tarda, está en Salud.
      </p>
    </>
  );
}

// Each skill's bar as long as its suggestions, filled by the share that was loaded.
function SkillRatio({ rows }: { rows: RouterReport["bySkill"] }) {
  if (rows.length === 0)
    return <p className="px-4 py-3 text-[12px] text-ink-2">Ninguna sugerencia en este periodo.</p>;
  const max = Math.max(...rows.map((s) => s.suggested));
  return (
    <ul aria-label="Sugerida → cargada" className="flex flex-col py-1 text-[12px]">
      {rows.map((s) => (
        <li key={s.name} className="flex items-center gap-2 px-4 py-1">
          <span className="w-[38%] min-w-0 shrink-0 truncate font-mono" title={s.name}>
            {s.name}
          </span>
          <span className="flex h-2 min-w-0 flex-1">
            <span
              className="flex h-full overflow-hidden rounded-r-[4px] bg-[var(--hover)]"
              style={{ width: widthOf(share(s.suggested, max)) }}
              title={`${s.accepted} de ${s.suggested} cargadas`}
            >
              <span
                className="h-full bg-[var(--cat-1)]"
                style={{ width: widthOf(share(s.accepted, s.suggested)) }}
              />
            </span>
          </span>
          <span className="min-w-24 shrink-0 text-right font-mono whitespace-nowrap tabular-nums">
            {s.accepted} de {s.suggested} · {of(s.accepted, s.suggested)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const SERIES = [
  {
    key: "acierto",
    name: "Acierto",
    color: "var(--cat-1)",
    of: (w: RouterWeek) => [w.accepted, w.suggested] as const,
  },
  {
    key: "tiempo",
    name: "A tiempo",
    color: "var(--cat-2)",
    of: (w: RouterWeek) => [w.delivered, w.notes] as const,
  },
] as const;

// Two shares a week on one axis from 0 to 100 %, and under each week which engine read its
// prompts: the hook or Log Pose.
function Trend({ weeks }: { weeks: RouterWeek[] }) {
  if (weeks.length === 0)
    return <p className="px-4 py-3 text-[12px] text-ink-2">Sin semanas con el router.</p>;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-[11px] text-ink-2">
      <p className="flex gap-4">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-1 w-3 rounded-[1px] bg-[var(--cat-3)]" />
          Con Log Pose
        </span>
      </p>
      <ol
        aria-label="Semana a semana"
        className="flex h-[120px] items-end gap-3 border-b border-line"
      >
        {weeks.map((w) => (
          <li
            key={w.week}
            className="flex h-full min-w-0 flex-1 items-end justify-center gap-[2px]"
          >
            {SERIES.map((s) => {
              const [part, whole] = s.of(w);
              return (
                <span
                  key={s.key}
                  className="w-3 rounded-t-[4px]"
                  style={{ height: widthOf(share(part, whole)), background: s.color }}
                  title={`${weekText(w.week)} · ${s.name}: ${of(part, whole)} (${part} de ${whole})`}
                />
              );
            })}
          </li>
        ))}
      </ol>
      <ol aria-label="Motor de cada semana" className="flex gap-3">
        {weeks.map((w) => (
          <li
            key={w.week}
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-[1px] bg-line"
            title={`${weekText(w.week)} · ${w.mod ?? 0} de ${w.runs} prompts con Log Pose`}
          >
            <span
              className="block h-full bg-[var(--cat-3)]"
              style={{ width: widthOf(share(w.mod ?? 0, w.runs)) }}
            />
          </li>
        ))}
      </ol>
      <p className="flex gap-3">
        {weeks.map((w) => (
          <span key={w.week} className="min-w-0 flex-1 truncate text-center">
            {weekText(w.week)}
          </span>
        ))}
      </p>
    </div>
  );
}
