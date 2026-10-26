import { type ReactNode, useState } from "react";
import { pct, share, widthOf } from "./charts.tsx";
import { ROLE_NAMES } from "./columns.tsx";
import { Panel, Section, Table } from "./kit.tsx";
import { amountOf } from "./ledger.ts";
import type { Ledger } from "./ledger-view.ts";
import { money, type UsageReport } from "./queries.ts";

// The models compared: who in a session spends on each one, and what the same tokens would have
// cost on another.

const ROLES = ["lead", "subagent", "advisor"] as const;
type Role = (typeof ROLES)[number];
// Fixed categorical slots, so a role keeps its colour whatever the period holds.
const ROLE_COLOR: Record<Role, string> = {
  lead: "var(--cat-1)",
  subagent: "var(--cat-2)",
  advisor: "var(--cat-3)",
};

export type ModelUse = { model: string; total: number; parts: Record<Role, number> };

// Each model's amount split by who spent it, largest model first.
export function modelUseOf(r: UsageReport, unit: Ledger["o"]["unit"]): ModelUse[] {
  const out = new Map<string, ModelUse>();
  for (const l of r.byModelRole) {
    const [role, model = ""] = l.key.split("|") as [Role, string?];
    if (!ROLES.includes(role)) continue;
    let m = out.get(model);
    if (!m) {
      m = { model, total: 0, parts: { lead: 0, subagent: 0, advisor: 0 } };
      out.set(model, m);
    }
    const v = amountOf(l, unit);
    m.parts[role] += v;
    m.total += v;
  }
  return [...out.values()].filter((m) => m.total > 0).sort((a, b) => b.total - a.total);
}

export type Repriced = { model: string; actual: number; as: number };

// What each Claude model's work cost, and what the same tokens cost at `key`'s price.
export function repricedOf(r: UsageReport, key: string): Repriced[] {
  const actual = new Map(r.byModel.map((l) => [l.key, l.cost ?? 0]));
  return Object.entries(r.repriced)
    .map(([model, as]) => ({ model, actual: actual.get(model) ?? 0, as: as[key] ?? 0 }))
    .filter((x) => x.actual > 0)
    .sort((a, b) => b.actual - a.actual);
}

export function Models({ r, L, children }: { r: UsageReport; L: Ledger; children?: ReactNode }) {
  const uses = modelUseOf(r, L.o.unit);
  const keys = Object.keys(Object.values(r.repriced)[0] ?? {}).sort();
  return (
    <Section
      id="usage-models"
      title="Modelos"
      hint="quién gasta en cada uno, qué costaría con otro y a qué nivel de effort"
    >
      <div className="grid gap-x-12 gap-y-12 lg:grid-cols-2">
        <Panel
          title="Quién usa cada modelo"
          question="¿lo gasta la sesión, sus subagentes o el advisor?"
          why="si los subagentes o el advisor pesan de más, el recorte está ahí"
          rows={uses.length}
          chart={(n) => <UseBars uses={uses.slice(0, n)} fmt={L.fmt} />}
          table={(n) => (
            <Table
              label="Quién usa cada modelo"
              rows={uses.slice(0, n)}
              rowKey={(u) => u.model}
              empty="Sin llamadas en este periodo."
              cols={[
                { head: "Modelo", cell: (u) => <span className="font-mono">{u.model}</span> },
                ...ROLES.map((role) => ({
                  head: ROLE_NAMES[role] ?? role,
                  num: true,
                  cell: (u: ModelUse) => (u.parts[role] ? L.fmt(u.parts[role]) : "—"),
                })),
                { head: "Total", num: true, cell: (u) => L.fmt(u.total) },
              ]}
            />
          )}
        />
        {L.o.unit === "money" && keys.length > 0 && <WhatIf r={r} keys={keys} />}
        {children}
      </div>
    </Section>
  );
}

function UseBars({ uses, fmt }: { uses: ModelUse[]; fmt: (n: number) => string }) {
  if (uses.length === 0)
    return <p className="px-4 py-3 text-[12px] text-ink-2">Sin llamadas en este periodo.</p>;
  const max = Math.max(...uses.map((u) => u.total));
  const whole = uses.reduce((n, u) => n + u.total, 0);
  return (
    <div className="flex flex-col gap-1 py-2 text-[12px]">
      <p className="flex gap-4 px-4 pb-1 text-[11px] text-ink-2">
        {ROLES.map((role) => (
          <span key={role} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-[2px]"
              style={{ background: ROLE_COLOR[role] }}
            />
            {ROLE_NAMES[role]}
          </span>
        ))}
      </p>
      <ul aria-label="Quién usa cada modelo" className="flex flex-col">
        {uses.map((u) => (
          <li key={u.model} className="flex items-center gap-2 px-4 py-1">
            <span className="w-[38%] min-w-0 shrink-0 truncate font-mono" title={u.model}>
              {u.model}
            </span>
            <span className="flex h-2 min-w-0 flex-1">
              <span
                className="flex h-full gap-[2px]"
                style={{ width: widthOf(share(u.total, max)) }}
              >
                {ROLES.map((role) =>
                  u.parts[role] > 0 ? (
                    <span
                      key={role}
                      className="h-full first:rounded-l-[2px] last:rounded-r-[4px]"
                      style={{
                        width: widthOf(share(u.parts[role], u.total)),
                        background: ROLE_COLOR[role],
                      }}
                      title={`${ROLE_NAMES[role]}: ${fmt(u.parts[role])}`}
                    />
                  ) : null,
                )}
              </span>
            </span>
            <span className="min-w-24 shrink-0 text-right font-mono whitespace-nowrap tabular-nums">
              {fmt(u.total)} · {pct(share(u.total, whole))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The same tokens at another model's price: an estimate, since another model would not spend
// the same tokens on the same work.
function WhatIf({ r, keys }: { r: UsageReport; keys: string[] }) {
  const [key, setKey] = useState(() => keys.find((k) => k.includes("sonnet")) ?? keys[0] ?? "");
  const rows = repricedOf(r, key);
  const actual = rows.reduce((n, x) => n + x.actual, 0);
  const as = rows.reduce((n, x) => n + x.as, 0);
  const max = Math.max(...rows.flatMap((x) => [x.actual, x.as]), 0);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Panel
        title="¿Y si fuera otro modelo?"
        question="estimación: los mismos tokens al precio de otro modelo"
        why="cuánto ahorraría cambiar el modelo por defecto"
        rows={rows.length}
        chart={(n) => (
          <ul
            aria-label="¿Y si fuera otro modelo?"
            className="flex flex-col gap-1 py-2 text-[12px]"
          >
            {rows.slice(0, n).map((x) => (
              <li key={x.model} className="flex items-center gap-2 px-4 py-1">
                <span className="w-[38%] min-w-0 shrink-0 truncate font-mono" title={x.model}>
                  {x.model}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span
                    className="block h-1.5 rounded-r-[4px]"
                    style={{ width: widthOf(share(x.actual, max)), background: "var(--cat-1)" }}
                    title={`Real: ${money(x.actual)}`}
                  />
                  <span
                    className="block h-1.5 rounded-r-[4px]"
                    style={{ width: widthOf(share(x.as, max)), background: "var(--ink-2)" }}
                    title={`Con ${key}: ${money(x.as)}`}
                  />
                </span>
                <span className="min-w-24 shrink-0 text-right font-mono whitespace-nowrap tabular-nums">
                  {money(x.actual)} → {money(x.as)}
                </span>
              </li>
            ))}
          </ul>
        )}
      />
      <p className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
        <label className="flex items-center gap-2">
          Con el precio de
          <select className="btn" value={key} onChange={(e) => setKey(e.target.value)}>
            {keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <span className="tabular-nums">
          {money(actual)} reales → {money(as)} ({as >= actual ? "+" : "−"}
          {pct(Math.abs(share(as - actual, actual)))}). Otro modelo no gastaría los mismos tokens.
        </span>
      </p>
      <p className="flex gap-4 text-[11px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-[var(--cat-1)]" />
          real
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-[var(--ink-2)]" />
          con el otro precio
        </span>
      </p>
    </div>
  );
}
