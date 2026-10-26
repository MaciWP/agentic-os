import { cn } from "cn";
import { type CSSProperties, type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tip } from "@/components/ui/tooltip";
import { Icon, type IconName } from "../../icons.tsx";
import type { UsageTab } from "./queries.ts";
import { type Target, type Verdict, verdictOf } from "./targets.ts";

// The one vocabulary Consumo is written in, so every part of the page reads the same way: a
// section with its title, a strip of figures, a label over a list, a table in a bordered box,
// and a note.

// What a figure is for: the decision it serves, behind an info icon beside its name, so the
// page reads as figures and the reason is one hover or one Tab away. The button carries the
// whole sentence as its name for readers.
export function Why({ children }: { children: string }) {
  const text = `Para qué: ${children}`;
  return (
    <Tip label={text} className="max-w-72">
      <button
        type="button"
        aria-label={text}
        className="inline-flex size-4 shrink-0 items-center justify-center self-center rounded-sm text-ink-2 opacity-60 hover:opacity-100 focus-visible:opacity-100"
      >
        <Icon name="info" size={13} />
      </button>
    </Tip>
  );
}

export function Section({
  id,
  title,
  hint,
  why,
  children,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  why?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 items-baseline gap-3">
        {/* A jump to a section lands below the sticky tab row, not under it. */}
        <h2 id={id} className="section-title shrink-0 scroll-mt-16">
          {title}
        </h2>
        {why && <Why>{why}</Why>}
        {hint && <span className="min-w-0 text-[12px] text-ink-2 tabular-nums">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

// The topics under the chart, one tab each: what was spent, by which model, whether Log Pose
// and the skill router help, what is broken, and what was used. Each keeps its colour on
// its underline; a panel whose first section does not already ask its question opens with it.
export const TABS: Record<
  UsageTab,
  { label: string; icon: IconName; color: string; question?: string }
> = {
  gasto: {
    label: "Gasto y tickets",
    icon: "receipt",
    color: "var(--cat-4)",
    question: "¿En qué se va el dinero y qué ticket se lo llevó?",
  },
  modelos: {
    label: "Modelos",
    icon: "cpu",
    color: "var(--cat-2)",
  },
  logpose: {
    label: "Log Pose",
    icon: "compass",
    color: "var(--cat-1)",
  },
  router: {
    label: "Router y skills",
    icon: "route",
    color: "var(--cat-1)",
  },
  salud: {
    label: "Salud",
    icon: "heart",
    color: "var(--cat-3)",
    question: "¿Hay algo roto que haga menos ciertas las cifras?",
  },
  inventario: {
    label: "Inventario",
    icon: "package",
    color: "var(--ink-2)",
    question: "¿Qué se usó? Recuentos sin objetivo.",
  },
};

// The row of topics, held under the page's top edge while the panel scrolls; on a phone it
// wraps to a second line rather than hide a tab past the edge. `badge` marks a
// tab whose panel holds something broken, so it shows from any other tab.
export function UsageTabList({ badge }: { badge: Partial<Record<UsageTab, number>> }) {
  return (
    <div className="sticky top-0 z-10 -mx-4 border-b border-line bg-bg px-4 md:-mx-8 md:px-8 xl:-mx-10 xl:px-10">
      <TabsList
        variant="line"
        aria-label="Temas de consumo"
        className="h-auto flex-wrap justify-start gap-x-6 p-0"
      >
        {(Object.keys(TABS) as UsageTab[]).map((id) => {
          const t = TABS[id];
          const n = badge[id] ?? 0;
          return (
            <TabsTrigger
              key={id}
              value={id}
              style={{ "--tab": t.color } as CSSProperties}
              className="h-11 flex-none gap-2 rounded-none px-0 text-[13px] font-medium text-ink-2 after:bg-[var(--tab)] group-data-horizontal/tabs:after:-bottom-px hover:text-ink data-active:text-ink [&_svg]:size-auto"
            >
              <span className="text-[var(--tab)]">
                <Icon name={t.icon} size={15} />
              </span>
              {t.label}
              {n > 0 && (
                <span
                  role="img"
                  aria-label={n === 1 ? "1 fallo" : `${n} fallos`}
                  className="ml-0.5 rounded-full bg-[color-mix(in_oklch,var(--bad)_18%,transparent)] px-1.5 text-[10px] leading-4 font-semibold text-bad tabular-nums"
                >
                  {n}
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </div>
  );
}

// The topic's question, when its first section does not ask it already.
export function TabHead({ tab }: { tab: UsageTab }) {
  const { question } = TABS[tab];
  return question ? <p className="max-w-[90ch] text-[13px] text-ink-2">{question}</p> : null;
}

const VERDICTS: Record<Verdict, { icon: IconName; text: string; className: string }> = {
  ok: { icon: "done", text: "en objetivo", className: "text-ok" },
  warn: { icon: "warning", text: "vigilar", className: "text-warn" },
  bad: { icon: "bad", text: "fuera", className: "text-bad" },
};

// A figure's target: its verdict in a shape and a word, never colour alone, and the goal.
export function Goal({ value, target }: { value: number | null; target: Target }) {
  if (value === null)
    return <span className="text-[11px] text-ink-2">objetivo {target.text} · sin dato</span>;
  const v = VERDICTS[verdictOf(value, target)];
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className={cn("inline-flex", v.className)}>
        <Icon name={v.icon} size={12} />
      </span>
      <span className={v.className}>{v.text}</span>
      <span className="text-ink-2">· objetivo {target.text}</span>
    </span>
  );
}

// What names a figure, a list or a chart inside a section.
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-[12px] text-ink-2", className)}>{children}</h3>;
}

const COLS = {
  2: "",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-3 xl:grid-cols-5",
} as const;

// Figures side by side, split by a rule, between two lines.
export function StatStrip({
  label,
  cols = 4,
  children,
}: {
  label: string;
  cols?: keyof typeof COLS;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "grid grid-cols-2 divide-x divide-[var(--line)] rounded-lg border border-line",
        COLS[cols],
      )}
    >
      {children}
    </section>
  );
}

// The only way the page shows a figure: what it is, the figure, and a line or two that read it.
export function Stat({
  label,
  value,
  sub,
  chart,
  tone,
  title,
  why,
  goal,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  chart?: ReactNode;
  tone?: "warn" | "bad";
  title?: string;
  // The decision the figure serves.
  why?: string;
  // Its target, with the figure as a share or a count to judge.
  goal?: { value: number | null; target: Target };
}) {
  const verdict = goal && goal.value !== null ? verdictOf(goal.value, goal.target) : null;
  const shade = tone ?? (verdict === "ok" || verdict === null ? undefined : verdict);
  return (
    <div className="flex min-w-0 flex-col gap-2 px-6 py-5" title={title}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Label className="min-w-0">{label}</Label>
        {why && <Why>{why}</Why>}
      </div>
      <span
        className={cn(
          "text-[22px] leading-none font-semibold tracking-[-0.01em] break-words tabular-nums",
          shade === "warn" && "text-warn",
          shade === "bad" && "text-bad",
        )}
      >
        {value}
      </span>
      {goal && <Goal {...goal} />}
      {/* A figure is never cut: in a narrow column it breaks before its unit. A note says
          what the figure means: it wraps rather than lose its end. A row that
          must stay on one line truncates itself, with a title. */}
      {sub && <div className="flex min-w-0 flex-col gap-0.5 text-[12px] text-ink-2">{sub}</div>}
      {chart}
    </div>
  );
}

export type Col<T> = {
  head: string;
  cell: (row: T) => ReactNode;
  num?: boolean;
  title?: (row: T) => string;
  className?: string;
};

// The only table: 12 px rows split by a line, numbers right-aligned in figures of one width.
export function Table<T>({
  label,
  rows,
  cols,
  rowKey,
  empty,
}: {
  label: string;
  rows: T[];
  cols: Col<T>[];
  rowKey: (row: T) => string;
  empty: string;
}) {
  if (rows.length === 0) return <p className="px-4 py-3 text-[12px] text-ink-2">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-ink-2">
            {cols.map((c) => (
              <th
                key={c.head}
                scope="col"
                className={cn("px-4 py-2 font-normal", c.num && "text-right", c.className)}
              >
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-t border-line hover:bg-[var(--hover)]">
              {cols.map((c) => (
                <td
                  key={c.head}
                  title={c.title?.(r)}
                  className={cn(
                    "px-4 py-2",
                    c.num && "text-right font-mono tabular-nums",
                    c.className,
                  )}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A table, or anything list-like, lives in one of these.
export function Box({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg border border-line", className)}>
      {children}
    </div>
  );
}

// Rows a panel shows before «Ver todo».
export const PANEL_ROWS = 8;

// One chart with the question it answers, its table on demand and, past PANEL_ROWS rows, the
// rest unfolded in place: never a box that scrolls inside the page.
export function Panel({
  title,
  question,
  rows,
  chart,
  table,
  why,
}: {
  title: string;
  question: string;
  why?: string;
  // How many rows there are in all.
  rows: number;
  chart: (limit: number) => ReactNode;
  table?: (limit: number) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const limit = all ? Number.POSITIVE_INFINITY : PANEL_ROWS;
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <header className="flex min-w-0 items-baseline gap-2">
        <h3 className="shrink-0 text-[13px] font-medium">{title}</h3>
        {why && <Why>{why}</Why>}
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2" title={question}>
          {question}
        </span>
        {table && (
          <button
            type="button"
            className="btn-ghost shrink-0 px-2"
            aria-pressed={asTable}
            onClick={() => setAsTable((t) => !t)}
          >
            {asTable ? "Ver como gráfico" : "Ver como tabla"}
          </button>
        )}
      </header>
      <Box>
        {asTable && table ? table(limit) : chart(limit)}
        {rows > PANEL_ROWS && (
          <button
            type="button"
            className="btn-ghost w-full rounded-none border-t border-line py-1.5 text-[12px]"
            aria-expanded={all}
            onClick={() => setAll((a) => !a)}
          >
            {all ? "Ver menos" : `Ver todo (${rows})`}
          </button>
        )}
      </Box>
    </section>
  );
}

// Something the reader should know before trusting the figures; "bad" when something failed.
// The actions sit in the row, not in the corner, because there can be two of them.
export function Note({
  tone = "info",
  title,
  action,
  children,
}: {
  tone?: "info" | "bad";
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Alert
      variant={tone === "bad" ? "destructive" : "default"}
      role={tone === "bad" ? "alert" : "note"}
      className="flex items-center gap-4 px-4 py-2.5"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <AlertTitle className="text-[12px]">{title}</AlertTitle>
        <AlertDescription className="text-[12px]">{children}</AlertDescription>
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </Alert>
  );
}
