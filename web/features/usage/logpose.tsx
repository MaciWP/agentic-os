import { cn } from "cn";
import type { RouterReport } from "../../../server/features/usage/router.ts";
import type { LogPoseView } from "../../../server/features/usage/types.ts";
import { Icon } from "../../icons.tsx";
import { pct, share, widthOf } from "./charts.tsx";
import {
  AdvisorFit,
  Dictation,
  EffortFit,
  fitShare,
  fitTotal,
  JudgeNote,
  LevelSignals,
} from "./judge.tsx";
import { Goal, Label, Note, Section, Stat, StatStrip, Table } from "./kit.tsx";
import { seconds } from "./poneglyph.tsx";
import { TARGETS, type Target } from "./targets.ts";

// Is Log Pose worth it? The mod replaced the router hook on Claude: one Sonnet call per typed
// prompt picks the skills, the turn's effort and an advisor gauge. Here, the hook's four weeks
// before it against the mod in the period, what it gives and what it costs, the levels it sets,
// whether they fit the work and whether the advisor follows its gauge (judge.tsx). Raw counts:
// what a turn would have cost at another level cannot be measured, so no saving in money is
// made up.

// Under this many classified prompts a share moves by whole points with one prompt.
export const SMALL_SAMPLE = 30;
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const DIFFICULTIES = ["easy", "normal", "hard"];
const DIFFICULTY_NAMES: Record<string, string> = {
  easy: "fácil",
  normal: "normal",
  hard: "difícil",
  "": "continuación",
};
// One hue, ordered like the levels: the cheaper ones fade into the panel, the dearer ones lean
// to the ink, so a higher level stands out more from the background in light and dark alike.
const LEVEL_SHADE: Record<string, string> = {
  low: "color-mix(in oklab, var(--cat-1) 45%, var(--panel))",
  medium: "var(--cat-1)",
  high: "color-mix(in oklab, var(--cat-1) 60%, var(--ink))",
  xhigh: "color-mix(in oklab, var(--cat-1) 25%, var(--ink))",
  max: "var(--ink)",
};
const shadeOf = (effort: string) => LEVEL_SHADE[effort] ?? "var(--cat-other)";
const levelRank = (e: string) => {
  const i = LEVELS.indexOf(e);
  return i < 0 ? LEVELS.length : i;
};

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const failedOf = (r: RouterReport) =>
  ratio(r.outcomes.error + r.outcomes["bad-output"] + r.outcomes.timeout, r.runs);
const USD = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4, minimumFractionDigits: 4 });
const usd = (n: number) => `${USD.format(n)} $`;

export type CompareRow = {
  name: string;
  why: string;
  before: number | null;
  after: number | null;
  // null: a change to read, neither good nor bad by itself.
  better: "up" | "down" | null;
  kind: "share" | "ms" | "usd";
  // The mod's target, when the row has one.
  target?: Target;
};

const HIGH = new Set(["high", "xhigh", "max"]);
const highShare = (calls: { effort: string; calls: number }[]) => {
  const said = calls.filter((c) => c.effort !== "");
  const all = said.reduce((n, c) => n + c.calls, 0);
  return ratio(
    said.filter((c) => HIGH.has(c.effort)).reduce((n, c) => n + c.calls, 0),
    all,
  );
};

// The hook's figures in its last four weeks against the mod's in the period, same rules.
export function compareOf(v: LogPoseView): CompareRow[] {
  const b = v.baseline;
  const m = v.mod;
  const r = v.report;
  const c = r.classify;
  return [
    {
      name: "Latencia (mediana)",
      why: "cuanto antes llega, más turnos la leen",
      before: b.latency.p50,
      after: m.latency.p50,
      better: "down",
      kind: "ms",
    },
    {
      name: "Llega a tiempo",
      why: "el hook, si una herramienta corrió después de su nota; el mod, por construcción: frena el prompt hasta tener respuesta, y sus fallos van en «Sin respuesta o error»",
      before: ratio(b.delivered, b.notes),
      after: ratio(r.onTime.delivered, r.onTime.notes),
      better: "up",
      kind: "share",
    },
    {
      name: "Acierto de skills",
      why: "sugerencias que se cargan",
      before: ratio(b.accepted, b.suggested),
      after: ratio(m.accepted, m.suggested),
      better: "up",
      kind: "share",
    },
    {
      name: "Se le escapan",
      why: "skills cargadas sin sugerir",
      before: ratio(b.missed, b.loads),
      after: ratio(m.missed, m.loads),
      better: "down",
      kind: "share",
    },
    {
      name: "Sin respuesta o error",
      why: "prompts que se quedan sin ayuda",
      before: failedOf(b),
      after: failedOf(m),
      better: "down",
      kind: "share",
    },
    {
      name: "Llamadas en high o más",
      why: "más barato, pero no mejor por sí solo",
      before: highShare(v.efforts.before),
      after: highShare(v.efforts.after),
      better: null,
      kind: "share",
    },
    {
      name: "Coste por prompt",
      why: "lo que cuesta la ayuda",
      before: b.cost.runs > 0 ? b.cost.usd / b.cost.runs : null,
      after: c.runs > 0 ? c.usd / c.runs : null,
      better: "down",
      kind: "usd",
    },
  ];
}

const valueText = (n: number | null, kind: CompareRow["kind"]) =>
  n === null ? "—" : kind === "share" ? pct(n) : kind === "ms" ? seconds(n) : usd(n);

function Delta({ row }: { row: CompareRow }) {
  const { before, after, kind } = row;
  if (before === null || after === null) return <span className="text-ink-2">—</span>;
  const d = after - before;
  const same = kind === "share" ? Math.abs(d) < 0.005 : Math.abs(d) < (kind === "ms" ? 50 : 1e-5);
  if (same) return <span className="text-ink-2">= igual</span>;
  const good = row.better === null ? null : row.better === "up" ? d > 0 : d < 0;
  const sign = d > 0 ? "+" : "−";
  const size =
    kind === "share"
      ? `${Math.round(Math.abs(d) * 100)} pp`
      : kind === "ms"
        ? seconds(Math.abs(d))
        : usd(Math.abs(d));
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        good === null ? "" : good ? "text-ok" : "text-bad",
      )}
    >
      {good !== null && <Icon name={good ? "done" : "bad"} size={12} />}
      {good !== null && <span className="sr-only">{good ? "mejor" : "peor"}</span>}
      {sign}
      {size}
    </span>
  );
}

const dayText = (iso: string) =>
  new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });

// `undefined` is a server older than this page, which sends no key: the same as no runs.
export function LogPose({ v }: { v: LogPoseView | null | undefined }) {
  return (
    <Section
      id="usage-logpose"
      title="Log Pose"
      hint="¿compensa el mod frente al hook? Elige el effort de cada turno y avisa del advisor"
    >
      {v == null ? (
        <p className="max-w-[90ch] text-[12px] text-ink-2">
          Log Pose no ha leído ningún prompt todavía: el router sigue con el hook.
        </p>
      ) : (
        <LogPoseBody v={v} />
      )}
    </Section>
  );
}

function LogPoseBody({ v }: { v: LogPoseView }) {
  const r = v.report;
  const j = v.judge;
  const rows = compareOf(v);
  const gauged = r.gauges.reduce((n, g) => n + g.turns, 0);
  const followed = r.gauges.reduce((n, g) => n + g.ok, 0);
  const effort = fitTotal(j.effort.chosen);
  const fixes = j.fixes.ok + j.fixes.wrong;
  const count = (pick: (e: string) => boolean) =>
    r.levels.filter((l) => pick(l.effort)).reduce((n, l) => n + l.count, 0);
  const cheap = count((e) => e === "low" || e === "medium");
  const dear = count((e) => e === "high" || e === "xhigh" || e === "max");
  return (
    <>
      {r.classified < SMALL_SAMPLE && (
        <Note title="Muestra pequeña">
          {r.classified} prompts clasificados en este periodo: con menos de {SMALL_SAMPLE}, un solo
          prompt mueve los porcentajes varios puntos.
        </Note>
      )}
      {(r.errors.length > 0 || r.unreadable > 0) && (
        <Note tone="bad" title="No se ha podido leer todo el registro de Log Pose">
          {r.unreadable > 0 && `${r.unreadable} líneas ilegibles. `}
          <span className="font-mono">{r.errors.join(" · ")}</span>
        </Note>
      )}
      <JudgeNote j={j} />
      <StatStrip label="Log Pose en este periodo" cols={5}>
        <Stat
          label="Opus corrige el nivel · ¿acierta la matriz?"
          value={
            ratio(r.overrides.length, r.classified) === null
              ? "—"
              : pct(share(r.overrides.length, r.classified))
          }
          goal={{ value: ratio(r.overrides.length, r.classified), target: TARGETS.overrides }}
          why="si sube, la matriz de effort está mal"
          sub={
            <span>
              {r.overrides.length} cambios con su herramienta, de {r.classified} prompts
            </span>
          }
        />
        <Stat
          label="Acierto del effort · ¿el juez pondría el mismo nivel?"
          value={effort === 0 ? "—" : pct(share(j.effort.chosen.ok, effort))}
          goal={{ value: fitShare(j.effort.chosen), target: TARGETS.effortFit }}
          why="si baja, revisar la matriz de effort"
          sub={
            <span>
              {effort === 0
                ? "sin veredictos del juez en este periodo"
                : `${j.effort.chosen.ok} de ${effort} turnos · le falta en ${j.effort.chosen.under} · le sobra en ${j.effort.chosen.over}`}
            </span>
          }
        />
        <Stat
          label="Medidor cumplido · ¿el advisor se llama lo que pide?"
          value={gauged === 0 ? "—" : pct(share(followed, gauged))}
          goal={{ value: ratio(followed, gauged), target: TARGETS.gaugeFollowed }}
          why="si baja, cambiar el texto del medidor"
          sub={
            <span>
              {followed} de {gauged} turnos con medidor llamaron al advisor las veces que pedía
            </span>
          }
        />
        <Stat
          label="Medidor bien puesto · ¿el juez pediría lo mismo?"
          value={fitTotal(j.gauge) === 0 ? "—" : pct(share(j.gauge.ok, fitTotal(j.gauge)))}
          goal={{ value: fitShare(j.gauge), target: TARGETS.gaugeFit }}
          why="si baja, revisar la regla del medidor"
          sub={
            <span>
              {fitTotal(j.gauge) === 0
                ? "sin veredictos del juez en este periodo"
                : `${j.gauge.ok} de ${fitTotal(j.gauge)} turnos clasificados`}
            </span>
          }
        />
        <Stat
          label="Dictado bien corregido · ¿el juez da por buenos los arreglos?"
          value={fixes === 0 ? "—" : pct(share(j.fixes.ok, fixes))}
          goal={{ value: ratio(j.fixes.ok, fixes), target: TARGETS.fixesRight }}
          why="si baja, revisar el glosario"
          sub={
            <span>
              {fixes === 0
                ? "sin arreglos juzgados en este periodo"
                : `${j.fixes.ok} de ${fixes} arreglos · ${j.fixes.missed} palabras sin arreglar`}
            </span>
          }
        />
      </StatStrip>
      <div className="flex flex-col gap-3">
        <Label>
          Antes y después: el hook del {dayText(v.baseline.from)} al {dayText(v.baseline.to)}, las
          cuatro semanas antes de activar Log Pose, frente a Log Pose en este periodo
        </Label>
        <Table
          label="Hook frente a Log Pose"
          rows={rows}
          rowKey={(row) => row.name}
          empty="Sin datos."
          cols={[
            {
              head: "Métrica",
              cell: (row) => (
                <span className="flex flex-col">
                  <span>{row.name}</span>
                  <span className="text-[11px] text-ink-2">{row.why}</span>
                  {row.target && <Goal value={row.after} target={row.target} />}
                </span>
              ),
            },
            { head: "Hook", num: true, cell: (row) => valueText(row.before, row.kind) },
            { head: "Log Pose", num: true, cell: (row) => valueText(row.after, row.kind) },
            { head: "Cambio", num: true, cell: (row) => <Delta row={row} /> },
          ]}
        />
        <p className="max-w-[90ch] text-[12px] text-ink-2">
          Hook: {v.baseline.runs.toLocaleString("es-ES")} prompts · Log Pose:{" "}
          {v.mod.runs.toLocaleString("es-ES")}. El coste del mod sale de sus tokens al precio de
          Sonnet: el log no lo trae, y la parte que no se lee de caché se cobra como escritura, así
          que tira por lo alto
          {r.classify.unpriced > 0 && `; ${r.classify.unpriced} llamadas quedan sin precio`}. El del
          hook sale de los prompts que lo registraron ({v.baseline.cost.runs} de{" "}
          {v.baseline.runs.toLocaleString("es-ES")}). Las llamadas por nivel son las de la sesión
          principal, sin subagentes ni advisor.
        </p>
      </div>
      <div className="grid gap-x-12 gap-y-12 lg:grid-cols-2">
        <Balance
          gives={[
            [`${cheap}`, "prompts en low o medium, los niveles baratos"],
            [`${dear}`, "prompts en high o más, para lo difícil"],
            [
              `${followed} de ${gauged}`,
              "turnos que llamaron al advisor las veces que pedía el medidor",
            ],
          ]}
          costs={[
            [
              r.classify.runs > 0 ? usd(r.classify.usd) : "—",
              `en clasificar ${r.classify.runs} prompts`,
            ],
            [String(r.overrides.length), "correcciones de nivel de Opus"],
            [String(r.steer), "prompts en steer: solo aviso, sin cambiar el nivel"],
            effort === 0
              ? ["—", "turnos por debajo del nivel justo: falta una pasada del juez"]
              : [
                  pct(share(j.effort.chosen.under, effort)),
                  "turnos por debajo del nivel que pondría el juez",
                ],
          ]}
          floor={r.floor}
        />
        <Levels levels={r.levels} />
        <EffortFit j={j} floor={r.floor.level} />
        <LevelSignals r={r} />
        <AdvisorFit r={r} j={j} />
        <Dictation r={r} j={j} />
        {r.overrides.length > 0 && (
          <div className="flex flex-col gap-2">
            <Label>Por qué corrige Opus el nivel</Label>
            <ul className="flex flex-col gap-1 text-[12px]">
              {r.overrides.slice(0, 8).map((o, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: overrides repeat and never reorder
                <li key={i} className="flex gap-2">
                  <span className="w-14 shrink-0 font-mono">{o.effort}</span>
                  <span className="min-w-0 text-ink-2">{o.reason || "sin motivo"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

function Balance({
  gives,
  costs,
  floor,
}: {
  gives: [string, string][];
  costs: [string, string][];
  floor: LogPoseView["report"]["floor"];
}) {
  const column = (title: string, rows: [string, string][], tone: string) => (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className={`text-[12px] font-semibold ${tone}`}>{title}</h4>
      <dl className="flex flex-col gap-1.5 text-[12px]">
        {rows.map(([value, what]) => (
          <div key={what} className="flex items-baseline gap-2">
            <dt className="min-w-16 shrink-0 font-mono tabular-nums">{value}</dt>
            <dd className="min-w-0 text-ink-2">{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
  return (
    <section aria-label="Balance de Log Pose" className="flex flex-col gap-2">
      <Label>Balance del periodo · ¿lo que aporta pesa más que lo que cuesta?</Label>
      <div className="grid grid-cols-2 gap-6 border-y border-line py-3">
        {column("Aporta", gives, "text-ok")}
        {column("Cuesta", costs, "text-warn")}
      </div>
      {floor.level && (
        <p className="max-w-[90ch] text-[12px] text-ink-2">
          Tu nivel fijado ({floor.level}) subió {floor.raised} de {floor.of} prompts: lo pones tú en
          settings.json, aparte del mod, así que no cuenta como acierto ni como fallo.
        </p>
      )}
    </section>
  );
}

// Per difficulty, the levels the prompts ran at, as one stacked bar each.
function Levels({ levels }: { levels: LogPoseView["report"]["levels"] }) {
  const keys = [...new Set(levels.map((l) => l.difficulty))].sort(
    (a, b) => (DIFFICULTIES.indexOf(a) + 1 || 9) - (DIFFICULTIES.indexOf(b) + 1 || 9),
  );
  const efforts = [...new Set(levels.map((l) => l.effort))].sort(
    (a, b) => levelRank(a) - levelRank(b),
  );
  return (
    <section aria-label="Niveles por dificultad" className="flex flex-col gap-2">
      <Label>Niveles que decide · ¿lo difícil va más alto que lo fácil?</Label>
      {keys.length === 0 ? (
        <p className="text-[12px] text-ink-2">Ningún prompt en este periodo.</p>
      ) : (
        <>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2">
            {efforts.map((e) => (
              <span key={e} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 rounded-[2px]"
                  style={{ background: shadeOf(e) }}
                />
                <span className="font-mono">{e || "sin nivel"}</span>
              </span>
            ))}
          </p>
          <ul className="flex flex-col gap-1.5 text-[12px]">
            {keys.map((d) => {
              const rows = levels.filter((l) => l.difficulty === d);
              const total = rows.reduce((n, l) => n + l.count, 0);
              return (
                <li key={d} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate">{DIFFICULTY_NAMES[d] ?? d}</span>
                  <span className="flex h-2.5 min-w-0 flex-1 gap-[2px]">
                    {efforts.map((e) => {
                      const n = rows.find((l) => l.effort === e)?.count ?? 0;
                      return n > 0 ? (
                        <span
                          key={e}
                          className="h-full first:rounded-l-[2px] last:rounded-r-[4px]"
                          style={{ width: widthOf(share(n, total)), background: shadeOf(e) }}
                          title={`${DIFFICULTY_NAMES[d] ?? d} · ${e || "sin nivel"}: ${n} de ${total}`}
                        />
                      ) : null;
                    })}
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono tabular-nums">{total}</span>
                </li>
              );
            })}
          </ul>
          <p className="max-w-[90ch] text-[11px] text-ink-2">
            Continuación: prompts que siguen la tarea anterior y heredan su nivel sin clasificar.
          </p>
        </>
      )}
    </section>
  );
}
