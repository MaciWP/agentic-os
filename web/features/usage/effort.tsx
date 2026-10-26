import { BarList, pct, share } from "./charts.tsx";
import { Panel, Stat, StatStrip, Table } from "./kit.tsx";
import { amountOf } from "./ledger.ts";
import type { Ledger } from "./ledger-view.ts";
import { money, type UsageLine, type UsageReport } from "./queries.ts";
import { TARGETS } from "./targets.ts";

// What thinking harder and asking the advisor cost: Claude's calls by the effort level they
// ran at and the advisor's share of the spend.

// Claude Code's levels, lowest first; a level it adds later goes after them.
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const HIGH = new Set(["high", "xhigh", "max"]);
const rankOf = (key: string) => {
  const i = LEVELS.indexOf(key);
  return key === "" ? LEVELS.length + 1 : i < 0 ? LEVELS.length : i;
};
const calls = (n: number) => `${n.toLocaleString("es-ES")} ${n === 1 ? "llamada" : "llamadas"}`;

export const effortsOf = (lines: UsageLine[]) =>
  [...lines].sort((a, b) => rankOf(a.key) - rankOf(b.key) || a.key.localeCompare(b.key));

export function SpendStats({ r, L }: { r: UsageReport; L: Ledger }) {
  const unit = L.o.unit;
  const advisor = r.byRole.find((l) => l.key === "advisor");
  const advisorAmount = advisor ? amountOf(advisor, unit) : 0;
  const levels = effortsOf(r.byEffort);
  const said = levels.filter((l) => l.key !== "");
  const saidAmount = said.reduce((n, l) => n + amountOf(l, unit), 0);
  const highAmount = said.filter((l) => HIGH.has(l.key)).reduce((n, l) => n + amountOf(l, unit), 0);
  const unsaid = levels.find((l) => l.key === "");
  return (
    <StatStrip label="Gasto en este periodo" cols={3}>
      <Stat
        label="Advisor · ¿cuánto pesa en el gasto?"
        value={L.fmt(advisorAmount)}
        goal={{
          value: L.o.amount > 0 ? advisorAmount / L.o.amount : null,
          target: TARGETS.advisorShare,
        }}
        why="si se dispara, el medidor de Log Pose no lo frena"
        sub={
          <>
            <span>
              {pct(share(advisorAmount, L.o.amount))} del periodo ·{" "}
              {advisor && advisor.calls > 0
                ? `${calls(advisor.calls)}, ${L.fmt(advisorAmount / advisor.calls)} cada una`
                : "ninguna llamada"}
            </span>
            <span>
              en {r.advisorSessions} de {r.claudeSessions} sesiones de Claude
            </span>
          </>
        }
      />
      <Stat
        label="Gasto en effort alto · ¿cuánto va a high o más?"
        value={said.length === 0 ? "Sin dato" : pct(share(highAmount, saidAmount))}
        why="si high o más se come el gasto, revisar la matriz de effort"
        sub={
          <span>
            de las llamadas de Claude con nivel anotado
            {unsaid && unsaid.calls > 0 && `; ${calls(unsaid.calls)} sin nivel`}
          </span>
        }
      />
      <Stat
        label="Ahorro por caché · ¿cuánto me ahorra la caché?"
        value={L.o.saved === null ? "—" : money(L.o.saved)}
        why="si baja de golpe, algo rompe la caché y el gasto sube"
        sub={<span>{pct(L.o.cacheShare)} de los tokens se leen de caché, más baratos</span>}
      />
    </StatStrip>
  );
}

// Claude's calls by the effort level they ran at.
export function EffortPanel({ r, L }: { r: UsageReport; L: Ledger }) {
  const unit = L.o.unit;
  const levels = effortsOf(r.byEffort);
  return (
    <Panel
      title="Gasto por nivel de effort"
      question="¿a qué nivel trabaja Claude y cuánto cuesta cada uno?"
      why="si high o más se come el gasto, bajar el nivel por defecto o la matriz de Log Pose"
      rows={levels.length}
      chart={(n) => (
        <BarList
          label="Gasto por nivel de effort"
          empty="Ninguna llamada de Claude en este periodo."
          bars={levels.slice(0, n).map((l) => ({
            key: l.key,
            label: l.key ? <span className="font-mono">{l.key}</span> : "sin nivel",
            text: l.key || "sin nivel",
            value: amountOf(l, unit),
            valueText: `${calls(l.calls)} · ${L.fmt(amountOf(l, unit))}`,
          }))}
        />
      )}
      table={(n) => (
        <Table
          label="Gasto por nivel de effort"
          rows={levels.slice(0, n)}
          rowKey={(l) => l.key}
          empty="Ninguna llamada de Claude en este periodo."
          cols={[
            {
              head: "Nivel",
              cell: (l) => (l.key ? <span className="font-mono">{l.key}</span> : "sin nivel"),
            },
            { head: "Llamadas", num: true, cell: (l) => l.calls.toLocaleString("es-ES") },
            { head: "Gasto", num: true, cell: (l) => L.fmt(amountOf(l, unit)) },
            {
              head: "Por llamada",
              num: true,
              cell: (l) => (l.calls ? L.fmt(amountOf(l, unit) / l.calls) : "—"),
            },
          ]}
        />
      )}
    />
  );
}
