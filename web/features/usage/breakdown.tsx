import type { ReactNode } from "react";
import { type Bar, BarList, pct, share, widthOf } from "./charts.tsx";
import {
  countCols,
  LONG_HEAD,
  longText,
  optionalLine,
  skillRows,
  subagentRows,
} from "./columns.tsx";
import { Panel, Table } from "./kit.tsx";
import {
  type HookLine,
  money,
  tokenText,
  totalTokens,
  type UsageLine,
  type UsageReport,
} from "./queries.ts";

// A breakdown row as a bar: its money when it has a price, else its tokens.
const lineBar = (key: string, label: ReactNode, l: UsageLine | undefined, extra = ""): Bar => {
  const value = l ? (l.cost ?? totalTokens(l)) : 0;
  const amount = !l ? "—" : l.cost !== null ? money(l.cost) : `${tokenText(totalTokens(l))} tok.`;
  return { key, label, text: key, value, valueText: extra ? `${amount} · ${extra}` : amount };
};
const countBar = (c: { name: string; count: number }): Bar => ({
  key: c.name,
  label: <span className="font-mono">{c.name}</span>,
  text: c.name,
  value: c.count,
  valueText: `${c.count}`,
});
const byValue = (bars: Bar[]) => [...bars].sort((a, b) => b.value - a.value);

// Each hook's runs as one bar: fine, blocked a call, failed or ran out of time.
function HookBars({ hooks }: { hooks: HookLine[] }) {
  if (hooks.length === 0)
    return <p className="px-4 py-3 text-[12px] text-ink-2">Ningún hook en este periodo.</p>;
  const runs = (h: HookLine) => h.ok + h.block + h.error + h.timeout;
  const max = Math.max(...hooks.map(runs), 0);
  const parts = (h: HookLine) =>
    [
      [h.ok, "var(--ok)", "bien"],
      [h.block, "var(--warn)", "bloquea"],
      [h.error + h.timeout, "var(--bad)", "falla"],
    ] as const;
  return (
    <div className="flex flex-col gap-1 py-2 text-[12px]">
      <p className="flex gap-4 px-4 pb-1 text-[11px] text-ink-2">
        {parts(hooks[0] as HookLine).map(([, color, word]) => (
          <span key={word} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: color }} />
            {word}
          </span>
        ))}
      </p>
      <ul aria-label="Hooks" className="flex flex-col">
        {hooks.map((h) => (
          <li key={h.name} className="flex items-center gap-2 px-4 py-1">
            <span className="w-[38%] min-w-0 shrink-0 truncate font-mono" title={h.name}>
              {h.name}
            </span>
            <span className="flex h-2 min-w-0 flex-1 gap-[2px]">
              <span
                className="flex h-full gap-[2px]"
                style={{ width: widthOf(share(runs(h), max)) }}
              >
                {parts(h).map(([n, color, word]) =>
                  n > 0 ? (
                    <span
                      key={word}
                      className="h-full first:rounded-l-[2px] last:rounded-r-[4px]"
                      style={{ width: widthOf(share(n, runs(h))), background: color }}
                      title={`${word}: ${n}`}
                    />
                  ) : null,
                )}
              </span>
            </span>
            <span className="min-w-24 shrink-0 text-right font-mono whitespace-nowrap tabular-nums">
              {runs(h)}
              {h.block + h.error + h.timeout > 0 &&
                ` · ${pct(share(h.block + h.error + h.timeout, runs(h)))}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Each hook's runs: which one fails, blocks or takes too long.
export function Hooks({ r }: { r: UsageReport }) {
  return (
    <div className="grid gap-x-12 gap-y-12 lg:grid-cols-2">
      <Panel
        title="Hooks"
        question="¿cuáles frenan o fallan?"
        why="qué hook arreglar, o quitar si frena sin aportar"
        rows={r.events.hooks.length}
        chart={(n) => <HookBars hooks={r.events.hooks.slice(0, n)} />}
        table={(n) => (
          <Table
            label="Hooks"
            rows={r.events.hooks.slice(0, n)}
            rowKey={(h) => h.name}
            empty="Ningún hook en este periodo."
            cols={[
              { head: "Hook", cell: (h) => <span className="font-mono">{h.name}</span> },
              { head: "Bien", num: true, cell: (h) => h.ok },
              { head: "Bloquea", num: true, cell: (h) => h.block },
              {
                head: "Falla",
                num: true,
                cell: (h) => <span className={h.error > 0 ? "text-bad" : ""}>{h.error}</span>,
              },
              {
                head: "Se pasa de tiempo",
                num: true,
                cell: (h) => <span className={h.timeout > 0 ? "text-bad" : ""}>{h.timeout}</span>,
              },
              {
                head: "Media",
                num: true,
                cell: (h) => (h.avgMs === null ? "—" : `${h.avgMs} ms`),
              },
              {
                head: "Total",
                num: true,
                cell: (h) =>
                  `${(h.totalMs / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 })} s`,
              },
            ]}
          />
        )}
      />
    </div>
  );
}

// What the harness used in the period, one panel per kind: counts with no target, for when a
// figure above asks which skill or tool. The ticket picked above does not filter it.
export function HarnessUse({ r }: { r: UsageReport }) {
  const skills = skillRows(r);
  const subagents = subagentRows(r);
  const skillBars = byValue(
    skills.map((sk) =>
      lineBar(sk.name, <span className="font-mono">{sk.name}</span>, sk.line, `${sk.loads} cargas`),
    ),
  );
  const subagentBars = byValue(
    subagents.map((sa) =>
      lineBar(sa.name, <span className="font-mono">{sa.name}</span>, sa.line, `×${sa.count}`),
    ),
  );
  return (
    <div className="grid gap-x-12 gap-y-12 lg:grid-cols-2">
      <Panel
        title="Skills"
        question="¿cuáles se cargan y cuánto gasta el trabajo con ellas?"
        rows={skills.length}
        chart={(n) => (
          <BarList
            label="Skills"
            empty="Ninguna skill en este periodo."
            bars={skillBars.slice(0, n)}
          />
        )}
        table={(n) => (
          <Table
            label="Skills"
            rows={skills.slice(0, n)}
            rowKey={(s) => s.name}
            empty="Ninguna skill en este periodo."
            cols={[
              { head: "Skill", cell: (s) => <span className="font-mono">{s.name}</span> },
              { head: "Cargas", num: true, cell: (s) => s.loads },
              { head: "Coste", num: true, cell: optionalLine((l) => money(l.cost)) },
              {
                head: "Tokens",
                num: true,
                cell: optionalLine((l) => tokenText(totalTokens(l))),
              },
            ]}
          />
        )}
      />
      <Panel
        title="Subagentes"
        question="¿qué se delega y cuánto cuesta?"
        rows={subagents.length}
        chart={(n) => (
          <BarList
            label="Subagentes"
            empty="Ningún subagente en este periodo."
            bars={subagentBars.slice(0, n)}
          />
        )}
        table={(n) => (
          <Table
            label="Subagentes"
            rows={subagents.slice(0, n)}
            rowKey={(s) => s.name}
            empty="Ningún subagente en este periodo."
            cols={[
              { head: "Tipo", cell: (s) => <span className="font-mono">{s.name}</span> },
              { head: "Lanzados", num: true, cell: (s) => s.count },
              {
                head: "Modelo pedido",
                cell: (s) => <span className="font-mono">{s.models}</span>,
              },
              { head: "Coste", num: true, cell: optionalLine((l) => money(l.cost)) },
              { head: LONG_HEAD, num: true, cell: optionalLine(longText) },
            ]}
          />
        )}
      />
      <CountPanel
        title="Comandos"
        question="¿qué comandos escribes?"
        head="Comando"
        rows={r.events.commands}
      />
      <CountPanel
        title="Herramientas"
        question="¿qué herramientas llaman los agentes?"
        head="Herramienta"
        rows={r.events.tools}
      />
      <CountPanel
        title="Servidores MCP"
        question="¿qué servidores MCP se usan?"
        head="Servidor"
        rows={r.events.mcp}
      />
    </div>
  );
}

function CountPanel({
  title,
  question,
  head,
  rows,
}: {
  title: string;
  question: string;
  head: string;
  rows: { name: string; detail: string; count: number }[];
}) {
  const empty = `Nada en este periodo.`;
  return (
    <Panel
      title={title}
      question={question}
      rows={rows.length}
      chart={(n) => <BarList label={title} empty={empty} bars={rows.slice(0, n).map(countBar)} />}
      table={(n) => (
        <Table
          label={title}
          rows={rows.slice(0, n)}
          rowKey={(c) => c.name}
          empty={empty}
          cols={countCols(head)}
        />
      )}
    />
  );
}
