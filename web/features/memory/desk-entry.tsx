import { cn } from "cn";
import type { ReactNode } from "react";
import { StatusIcon } from "../tickets/icons.tsx";
import { WRITABLE } from "./desk-model.ts";
import type { Tk } from "./desk-tickets.ts";
import { SOURCE_LABEL } from "./panel.tsx";
import type { DocSummary } from "./queries.ts";

export function Entry({
  open,
  onOpen,
  d,
  when,
  detail,
  tk,
}: {
  open: string | undefined;
  onOpen: (id: string) => void;
  d: DocSummary;
  when: string;
  detail?: ReactNode;
  tk: Tk;
}) {
  const keys = tk.in(d);
  const harness = !WRITABLE.includes(d.source);
  const sub = detail ?? d.description ?? (harness ? d.rel : null);
  return (
    <li>
      <button
        type="button"
        data-doc={d.id}
        aria-current={open === d.id ? "true" : undefined}
        onClick={() => onOpen(d.id)}
        className={cn(
          "grid w-full scroll-my-10 grid-cols-[46px_minmax(0,1fr)] gap-2 rounded-md px-2 py-2 text-left",
          open === d.id ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]",
        )}
      >
        <span className="pt-px text-[12px] text-ink-2 tabular-nums">{when}</span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="line-clamp-2 text-[13.5px] leading-snug font-medium" title={d.title}>
            {d.title}
          </span>
          {(keys.length > 0 || d.source !== "notes") && (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11.5px] text-ink-2">
              {keys.slice(0, 3).map((k) => {
                const t = tk.of(k);
                return (
                  <span key={k} className="pill inline-flex shrink-0 items-center gap-1 font-mono">
                    {t && <StatusIcon status={t.status.name} category={t.status.category} />}
                    {k}
                  </span>
                );
              })}
              {keys.length > 3 && <span className="tabular-nums">+{keys.length - 3}</span>}
              {d.source !== "notes" && <span className="truncate">{SOURCE_LABEL[d.source]}</span>}
            </span>
          )}
          {sub && (
            <span
              className={cn(
                "line-clamp-2 text-[12px] leading-snug text-ink-2",
                harness && !detail && !d.description && "font-mono text-[11px]",
              )}
              title={typeof sub === "string" ? sub : undefined}
            >
              {sub}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
