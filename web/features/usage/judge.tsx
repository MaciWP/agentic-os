import type { Fit, JudgeReport } from "../../../server/features/usage/judge.ts";
import type { LogPoseReport } from "../../../server/features/usage/logpose.ts";
import { useAccess } from "../../access.ts";
import { errorText } from "../../ui.tsx";
import { pct, share, widthOf } from "./charts.tsx";
import { Box, Label, Note, Table } from "./kit.tsx";
import { useJudge } from "./queries.ts";

// Does Log Pose set the right effort, advisor gauge and dictation fixes? Two readings: leads
// from the turns themselves, with no model, and the verdicts of a weekly judge (Sonnet) that
// reads each prompt without the level or gauge the mod set. The judge only says what it would
// have set; the page compares.

const FIT = [
  { key: "under", name: "le falta", color: "var(--cat-1)" },
  { key: "ok", name: "acierta", color: "var(--cat-other)" },
  { key: "over", name: "le sobra", color: "var(--cat-2)" },
] as const;

export const fitTotal = (f: Fit) => f.under + f.ok + f.over;
export const fitShare = (f: Fit) => (fitTotal(f) > 0 ? f.ok / fitTotal(f) : null);

const USD = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const usd = (n: number) => `${USD.format(n)} $`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });

// The judge's last pass and the button that runs one over this period, with its price.
export function JudgeNote({ j }: { j: JudgeReport }) {
  const judge = useJudge();
  // A pass spends on a model run, so the server takes it from the Mac only.
  const remote = useAccess().data?.desktop === false;
  const last = j.last;
  const busy = j.running || judge.isPending;
  const price = j.estimate.usd === null ? "" : ` · ≈${usd(j.estimate.usd)}`;
  const failed = last?.state === "failed" || judge.isError;
  return (
    <Note
      tone={failed ? "bad" : "info"}
      title="Juez semanal: Sonnet lee cada prompt sin ver el nivel ni el medidor que puso el mod"
      action={
        <button
          type="button"
          className="btn"
          disabled={busy || remote || !j.available || j.turns === 0}
          title={
            remote
              ? "Lánzalo desde el Mac: gasta en una llamada a Sonnet"
              : j.available
                ? undefined
                : "Este servidor no puede llamar a Claude"
          }
          onClick={() => judge.mutate(j.span)}
        >
          {busy ? "Juzgando…" : `${j.judged > 0 ? "Repetir" : "Juzgar este periodo"}${price}`}
        </button>
      }
    >
      <span className="flex flex-col gap-0.5">
        <span>
          {j.judged} de {j.turns} turnos de este periodo tienen veredicto.{" "}
          {j.auto
            ? "Cada lunes juzga solo la semana anterior; el botón, este periodo."
            : "La pasada de los lunes está apagada; el botón juzga este periodo."}
        </span>
        {last && (
          <span>
            {last.state === "running"
              ? `Juzgando del ${day(last.from)} al ${day(last.to)}: ${last.judged} de ${last.turns} turnos.`
              : `Última pasada el ${when(last.startedAt)} (${last.trigger === "auto" ? "automática" : "a mano"}), del ${day(last.from)} al ${day(last.to)}: ${last.judged} de ${last.turns} turnos, ${usd(last.usd)}.`}
            {last.state === "capped" && " Se cortó al llegar al tope de 5 $."}
            {last.state === "failed" && ` Falló: ${last.error ?? "sin motivo"}.`}
            {last.unmatched > 0 &&
              ` ${last.unmatched} turnos sin juzgar: su transcript no tiene el prompt.`}
          </span>
        )}
        {judge.isError && <span>{errorText(judge.error)}</span>}
      </span>
    </Note>
  );
}

function FitLegend() {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2">
      {FIT.map((f) => (
        <span key={f.key} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px]" style={{ background: f.color }} />
          {f.name}
        </span>
      ))}
    </p>
  );
}

// One stacked bar per row: the turns short of the judge's level, on it and past it.
function FitBars({ rows }: { rows: { name: string; fit: Fit }[] }) {
  return (
    <ul className="flex flex-col gap-1.5 text-[12px]">
      {rows.map(({ name, fit }) => {
        const total = fitTotal(fit);
        return (
          <li key={name} className="flex items-center gap-2">
            <span className="w-16 shrink-0 font-mono">{name}</span>
            <span className="flex h-2.5 min-w-0 flex-1 gap-[2px]">
              {FIT.map((f) =>
                fit[f.key] > 0 ? (
                  <span
                    key={f.key}
                    className="h-full first:rounded-l-[2px] last:rounded-r-[4px]"
                    style={{ width: widthOf(share(fit[f.key], total)), background: f.color }}
                    title={`${name} · ${f.name}: ${fit[f.key]} de ${total}`}
                  />
                ) : null,
              )}
            </span>
            <span className="min-w-24 shrink-0 text-right font-mono whitespace-nowrap tabular-nums">
              {fit.ok} de {total} · {pct(share(fit.ok, total))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// The mod's level against the judge's, by the level it chose; then the level that ran, which
// your own floor may have lifted.
export function EffortFit({ j, floor }: { j: JudgeReport; floor: string | null }) {
  const applied = fitShare(j.effort.applied);
  return (
    <section aria-label="¿Elige bien el effort?" className="flex min-w-0 flex-col gap-2">
      <Label>¿Elige bien el effort? · el nivel del mod frente al que pondría el juez</Label>
      {j.judged === 0 ? (
        <p className="text-[12px] text-ink-2">Sin veredictos del juez en este periodo.</p>
      ) : (
        <>
          <FitLegend />
          <FitBars rows={j.byChosen.map((r) => ({ name: r.effort, fit: r }))} />
          {applied !== null && (
            <p className="max-w-[90ch] text-[12px] text-ink-2">
              {floor ? `Con tu nivel fijado (${floor}), el nivel` : "El nivel"} que corrió acierta{" "}
              {pct(applied)}: le falta en {j.effort.applied.under} turnos y le sobra en{" "}
              {j.effort.applied.over}.
            </p>
          )}
          <Worst rows={j.worst} />
        </>
      )}
    </section>
  );
}

function Worst({ rows }: { rows: JudgeReport["worst"] }) {
  if (rows.length === 0) return null;
  return (
    <details className="text-[12px]">
      <summary className="cursor-pointer text-ink-2">
        {rows.length === 1
          ? "El turno más lejos del juez"
          : `Los ${rows.length} turnos más lejos del juez`}
      </summary>
      <ul className="mt-2 flex flex-col gap-2.5">
        {rows.map((w) => (
          <li key={w.at} className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono">
              {when(w.at)} · mod {w.chosen || "—"} · corrió {w.applied || "—"} · juez {w.judged}
            </span>
            <span className="text-ink-2">{w.why}</span>
            {w.prompt && (
              <span className="truncate text-ink-2 italic" title={w.prompt}>
                «{w.prompt}»
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

// Per level that ran, what the turns did and the leads for too little or too much: no model
// reads them, so they are leads only, and the judge decides.
export function LevelSignals({ r }: { r: LogPoseReport }) {
  const { underSteps, overSteps, overTools } = r.leads;
  return (
    <section aria-label="Señales por nivel" className="flex min-w-0 flex-col gap-2">
      <Label>Señales por nivel que corrió · pistas sin IA, el juez decide</Label>
      <Box>
        <Table
          label="Señales por nivel"
          rows={r.byLevel}
          rowKey={(l) => l.effort}
          empty="Ningún turno en este periodo."
          cols={[
            {
              head: "Nivel",
              cell: (l) => <span className="font-mono">{l.effort || "sin nivel"}</span>,
            },
            { head: "Turnos", num: true, cell: (l) => l.turns },
            {
              head: "Pasos",
              num: true,
              cell: (l) => l.stepsP50 ?? "—",
              title: () => "mediana de llamadas al modelo por turno",
            },
            {
              head: "Coste medio",
              num: true,
              cell: (l) => (l.priced > 0 ? usd(l.usd / l.priced) : "—"),
            },
            { head: "¿Falta?", num: true, cell: (l) => l.under },
            { head: "¿Sobra?", num: true, cell: (l) => l.over },
          ]}
        />
      </Box>
      <p className="max-w-[90ch] text-[11px] text-ink-2">
        ¿Falta?: low o medium con {underSteps} pasos o más, o Opus subió el nivel. ¿Sobra?: high o
        más con {overSteps} pasos o menos y {overTools} herramienta como mucho. Coste a precio de
        Opus, sin advisor ni subagentes.
      </p>
    </section>
  );
}

// What each gauge asks, in the words of the mod's note.
const ASKS = [
  "no llamarlo",
  "solo si se atasca o antes de un paso arriesgado",
  "una vez antes de dar por acabado",
  "antes del plan, al atascarse y antes de acabar",
];
// A gauge with no floor cannot fall short; one with no ceiling cannot go over.
const CANNOT: Record<number, "under" | "over"> = { 0: "under", 1: "under", 3: "over" };

// Per gauge, whether the turns called the advisor as many times as it asks; then whether the
// judge would have set the same gauge.
export function AdvisorFit({ r, j }: { r: LogPoseReport; j: JudgeReport }) {
  const count = (g: (typeof r.gauges)[number], key: "under" | "over") =>
    CANNOT[g.gauge] === key ? "—" : g[key];
  const judged = fitTotal(j.gauge);
  return (
    <section aria-label="¿Pide bien el advisor?" className="flex min-w-0 flex-col gap-2">
      <Label>¿Pide bien el advisor? · llamadas por turno frente a lo que pide el medidor</Label>
      <Box>
        <Table
          label="Medidor frente al advisor"
          rows={r.gauges}
          rowKey={(g) => String(g.gauge)}
          empty="Ningún turno con medidor en este periodo."
          cols={[
            {
              head: "Medidor",
              cell: (g) => (
                <span className="flex flex-col">
                  <span>medidor {g.gauge}</span>
                  <span className="text-[11px] text-ink-2">{ASKS[g.gauge]}</span>
                </span>
              ),
            },
            { head: "Turnos", num: true, cell: (g) => g.turns },
            {
              head: "Cumple",
              num: true,
              className: "whitespace-nowrap",
              cell: (g) => `${g.ok} · ${pct(share(g.ok, g.turns))}`,
            },
            { head: "Corto", num: true, cell: (g) => count(g, "under") },
            {
              head: "De más",
              num: true,
              className: "whitespace-nowrap",
              cell: (g) => count(g, "over"),
            },
            {
              head: "Advisor",
              num: true,
              className: "whitespace-nowrap",
              cell: (g) => usd(g.advisorUsd),
            },
          ]}
        />
      </Box>
      <p className="max-w-[90ch] text-[12px] text-ink-2">
        {judged === 0
          ? "Medidor bien puesto: sin veredictos del juez en este periodo."
          : `El juez pondría el mismo medidor en ${j.gauge.ok} de ${judged} turnos; uno más alto en ${j.gauge.under} y uno más bajo en ${j.gauge.over}.`}
      </p>
    </section>
  );
}

// The words the dictation got wrong: what the mod fixed, and what the judge says of it.
export function Dictation({ r, j }: { r: LogPoseReport; j: JudgeReport }) {
  const d = r.dictation;
  const judged = j.fixes.ok + j.fixes.wrong;
  return (
    <section aria-label="Dictado" className="flex min-w-0 flex-col gap-2">
      <Label>Dictado · ¿corrige lo que el micro oye mal?</Label>
      <p className="text-[12px]">
        {d.total} arreglos en {d.prompts} de {r.classified} prompts clasificados.
      </p>
      {d.logged === 0 ? (
        <p className="max-w-[90ch] text-[12px] text-ink-2">
          Ningún prompt de este periodo trae los pares oído → corregido: el mod los guarda desde su
          versión 0.3.2.
        </p>
      ) : d.pairs.length === 0 ? (
        <p className="max-w-[90ch] text-[12px] text-ink-2">
          {d.logged} prompts traen los pares, y ninguno con un arreglo.
        </p>
      ) : (
        <ul aria-label="Arreglos más repetidos" className="flex flex-col gap-1 text-[12px]">
          {d.pairs.map((p) => (
            <li key={`${p.heard}\0${p.meant}`} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-mono" title={`${p.heard} → ${p.meant}`}>
                {p.heard} → {p.meant}
              </span>
              <span className="ml-auto shrink-0 font-mono text-ink-2 tabular-nums">×{p.count}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="max-w-[90ch] text-[12px] text-ink-2">
        {judged === 0
          ? "El juez aún no ha visto arreglos en este periodo."
          : `El juez da por buenos ${j.fixes.ok} de ${judged} arreglos.`}
        {j.fixes.missed > 0 &&
          ` Se quedaron sin arreglar ${j.fixes.missed} palabras: ${j.fixes.missedTop
            .map((m) => (m.count > 1 ? `${m.word} ×${m.count}` : m.word))
            .join(", ")}.`}
      </p>
    </section>
  );
}
