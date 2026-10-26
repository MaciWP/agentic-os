import { plural } from "../../format.ts";
import { PCT0, pct, share } from "./charts.tsx";
import { Stat, StatStrip } from "./kit.tsx";
import { ALL, amountOf, unitOf } from "./ledger.ts";
import type { UsageReport } from "./queries.ts";
import { TARGETS } from "./targets.ts";

// Whether Poneglyph works as a configuration layer, read from what the harnesses did: is any
// part of it broken, and do its skills get used.

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const NUM = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
export const seconds = (ms: number) =>
  ms < 60_000 ? `${NUM.format(ms / 1000)} s` : `${NUM.format(ms / 60_000)} min`;

export type Health = {
  sessions: number;
  hooks: { runs: number; blocks: number; failures: number; ms: number; worst: string[] };
  skills: { share: number; loads: number; distinct: number };
};

export function healthOf(r: UsageReport): Health {
  const unit = unitOf(r);
  const amount = amountOf(r.total, unit);
  const hooks = r.events.hooks;
  return {
    sessions: r.tickets[ALL]?.sessionCount ?? 0,
    hooks: {
      runs: sum(hooks.map((h) => h.ok + h.block + h.error + h.timeout)),
      blocks: sum(hooks.map((h) => h.block)),
      failures: sum(hooks.map((h) => h.error + h.timeout)),
      ms: sum(hooks.map((h) => h.totalMs)),
      worst: hooks.filter((h) => h.error + h.timeout > 0).map((h) => h.name),
    },
    skills: {
      share: share(sum(r.bySkill.map((l) => amountOf(l, unit))), amount),
      loads: sum(r.events.skills.map((s) => s.count)),
      distinct: new Set(r.events.skills.map((s) => s.name)).size,
    },
  };
}

const perSession = (n: number, sessions: number) => (sessions > 0 ? NUM.format(n / sessions) : "—");

// The hooks card's figure: no hook ran is no data, not a clean run.
export const hooksValue = (hooks: { runs: number; failures: number }) =>
  hooks.runs === 0
    ? "Sin datos"
    : hooks.failures === 0
      ? "Sin fallos"
      : plural(hooks.failures, "fallo", "fallos");

// Files of the period the page could not read: transcripts, router lines and Log Pose rows.
const unreadOf = (r: UsageReport) =>
  r.ingest.errors.length + (r.router?.unreadable ?? 0) + (r.logPose?.report?.unreadable ?? 0);

// What is plainly broken, for the mark on the Salud tab: failed hook runs and unread files.
export const healthFaults = (r: UsageReport) => healthOf(r).hooks.failures + unreadOf(r);

// What is broken: hooks that fail, a router that does not answer, models with no price and
// files the page could not read. Each one makes a figure above less true.
export function HealthStats({ r }: { r: UsageReport }) {
  const h = healthOf(r);
  const { hooks } = h;
  const router = r.router;
  const o = router?.outcomes;
  const failed = o ? o.error + o["bad-output"] + o.timeout : 0;
  const pose = r.logPose?.report;
  const unpriced =
    r.unpriced.length === 0
      ? "todos los modelos tienen precio en la configuración"
      : r.unpriced.join(", ");
  const unread = unreadOf(r);
  return (
    <StatStrip label="Salud en este periodo" cols={5}>
      <Stat
        label="Hooks · ¿alguno falla o frena de más?"
        value={hooksValue(hooks)}
        goal={{ value: hooks.runs === 0 ? null : hooks.failures, target: TARGETS.hookFailures }}
        why="qué hook arreglar"
        sub={
          <>
            <span>
              {hooks.runs.toLocaleString("es-ES")} ejecuciones · {hooks.blocks} bloqueos (
              {pct(share(hooks.blocks, hooks.runs))})
            </span>
            <span>
              {seconds(hooks.ms)} en total · {h.sessions > 0 ? seconds(hooks.ms / h.sessions) : "—"}{" "}
              por sesión
            </span>
            {hooks.worst.length > 0 && (
              <span className="truncate font-mono text-bad" title={hooks.worst.join(", ")}>
                {hooks.worst.join(", ")}
              </span>
            )}
          </>
        }
      />
      <Stat
        label="Router · ¿responde a tiempo?"
        value={!router || router.runs === 0 ? "—" : pct(share(failed, router.runs))}
        goal={{
          value: router && router.runs > 0 ? failed / router.runs : null,
          target: TARGETS.failed,
        }}
        why="si sube, volver al hook o revisar el modelo que clasifica"
        sub={
          o && router ? (
            <>
              <span>
                sin respuesta o con error · {o.timeout} tarde · {o.error + o["bad-output"]} errores
                de {router.runs.toLocaleString("es-ES")}
              </span>
              <span>
                mediana {router.latency.p50 === null ? "—" : seconds(router.latency.p50)} · p90{" "}
                {router.latency.p90 === null ? "—" : seconds(router.latency.p90)}
              </span>
            </>
          ) : (
            <span>sin datos del router en este periodo</span>
          )
        }
      />
      <Stat
        label="Roturas de caché · ¿cambiar de nivel la rompe?"
        value={pose ? String(pose.cacheBreaks) : "—"}
        goal={{ value: pose ? pose.cacheBreaks : null, target: TARGETS.cacheBreaks }}
        why="dos seguidas pasan Log Pose a solo avisar (steer)"
        sub={
          <span>
            {pose
              ? `en ${pose.levelChanges} cambios de nivel · ${pose.steer} prompts en steer`
              : "sin Log Pose en este periodo"}
          </span>
        }
      />
      <Stat
        label="Sin precio · ¿qué falta en el coste?"
        value={r.unpriced.length === 0 ? "Nada" : String(r.unpriced.length)}
        tone={r.unpriced.length > 0 ? "warn" : undefined}
        why="un modelo sin precio deja su gasto fuera de las cifras en €"
        sub={
          <span className="truncate font-mono" title={unpriced}>
            {unpriced}
          </span>
        }
      />
      <Stat
        label="Ilegibles · ¿se pierde algo al leer?"
        value={unread === 0 ? "Nada" : String(unread)}
        tone={unread > 0 ? "warn" : undefined}
        why="lo que no se lee falta en todas las cifras"
        sub={
          <span>
            {r.ingest.errors.length} transcripts · {router?.unreadable ?? 0} líneas del router ·{" "}
            {r.logPose?.report.unreadable ?? 0} de Log Pose
          </span>
        }
      />
    </StatStrip>
  );
}

// How much of the work runs with a skill loaded: the reach of the skill catalog.
export function SkillReach({ r }: { r: UsageReport }) {
  const h = healthOf(r);
  const { skills } = h;
  return (
    <StatStrip label="Alcance de skills" cols={2}>
      <Stat
        label="Alcance de skills · ¿qué parte del gasto va con una skill?"
        value={PCT0.format(skills.share)}
        why="si baja, las skills no cubren el trabajo diario"
        sub={<span>del consumo, con una skill activa</span>}
      />
      <Stat
        label="Cargas · ¿cuántas skills se usan?"
        value={perSession(skills.loads, h.sessions)}
        why="pocas distintas apunta a skills que nadie carga: al Inventario a ver cuáles"
        sub={
          <span>
            por sesión · {skills.loads} cargas · {skills.distinct} distintas
          </span>
        }
      />
    </StatStrip>
  );
}
