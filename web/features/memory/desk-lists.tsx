import { cn } from "cn";
import type { ReactNode } from "react";
import type { Hit } from "../../../server/features/memory/store.ts";
import { ErrorState, errorText, InlineError, SkeletonRows } from "../../ui.tsx";
import { Entry } from "./desk-entry.tsx";
import { ago } from "./desk-model.ts";
import { TicketMark } from "./desk-rail.tsx";
import type { Tk } from "./desk-tickets.ts";
import { dayLabel, NONE, shortDate, shortDay } from "./journal.ts";
import { Snippet } from "./panel.tsx";
import { type Doc, useMemorySearch } from "./queries.ts";

export function GroupHead({ children, count }: { children: ReactNode; count: number }) {
  return (
    <h2 className="sticky top-0 z-[1] flex min-w-0 items-center gap-2 border-b border-line bg-[var(--bg)] px-2 py-1.5 text-[12px] font-semibold">
      {children}
      <span className="ml-auto shrink-0 font-normal text-ink-2 tabular-nums">{count}</span>
    </h2>
  );
}

export function DayHead({ day, now }: { day: string; now: number }) {
  const label = dayLabel(day, now);
  return (
    <>
      <span className="first-letter:uppercase">{label}</span>
      {label.length < 10 && <span className="font-normal text-ink-2">{shortDate(day)}</span>}
    </>
  );
}

export function TicketHead({ k, tk }: { k: string; tk: Tk }) {
  const t = tk.of(k);
  return (
    <>
      <TicketMark k={k} t={t} />
      <span className={cn("shrink-0 whitespace-nowrap", k === NONE ? "text-ink-2" : "font-mono")}>
        {k}
      </span>
      {t && (
        <span className="truncate font-normal text-ink-2" title={`${t.summary} · ${t.status.name}`}>
          {t.status.name} · {t.summary}
        </span>
      )}
    </>
  );
}

export function Hits({
  q,
  open,
  onOpen,
  now,
  tk,
}: {
  q: string;
  open: string | undefined;
  onOpen: (id: string) => void;
  now: number;
  tk: Tk;
}) {
  const search = useMemorySearch(q);
  if (search.isPending) return <SkeletonRows count={3} />;
  if (search.isError) return <ErrorState error={search.error} onRetry={() => search.refetch()} />;
  const hits = search.data.hits;
  if (hits.length === 0)
    return <p className="px-2 py-2 text-[12px] text-ink-2">Nada coincide con «{q.trim()}».</p>;
  return (
    <section aria-label="Resultados">
      <GroupHead count={hits.length}>Resultados</GroupHead>
      <ul aria-label="Resultados" className="flex flex-col pt-1">
        {hits.map((x: Hit) => (
          <Entry
            key={x.id}
            open={open}
            onOpen={onOpen}
            d={x}
            when={shortDay(x.mtime, now)}
            detail={<Snippet text={x.snippet} />}
            tk={tk}
          />
        ))}
      </ul>
    </section>
  );
}

// Below the note: the other notes of its first ticket, and the notes that mention it.
export function Related({
  doc,
  keys,
  tk,
  now,
  onOpen,
}: {
  doc: Doc;
  keys: string[];
  tk: Tk;
  now: number;
  onOpen: (id: string) => void;
}) {
  const key = keys[0];
  const search = useMemorySearch(key ?? doc.title);
  const body = (list: Hit[], empty: string) =>
    list.length === 0 ? (
      <p className="px-2 text-[12px] text-ink-2">{empty}</p>
    ) : (
      <ul className="flex flex-col">
        {list.slice(0, 6).map((x) => (
          <li key={x.id}>
            <button
              type="button"
              onClick={() => onOpen(x.id)}
              className="flex w-full min-w-0 items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--hover)]"
            >
              <span className="truncate">{x.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-ink-2">{ago(x, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  let content: ReactNode;
  if (search.isPending) content = <SkeletonRows count={2} />;
  else if (search.isError)
    content = (
      <InlineError className="text-[12px]">
        No se pudo buscar lo relacionado: {errorText(search.error)}{" "}
        <button type="button" className="btn-ghost" onClick={() => search.refetch()}>
          Reintentar
        </button>
      </InlineError>
    );
  else {
    const others = search.data.hits.filter((h) => h.id !== doc.id);
    const same = key ? others.filter((x) => tk.in(x).includes(key)) : [];
    const mention = others.filter((x) => !same.includes(x));
    content = (
      <div className="grid grid-cols-2 gap-6">
        {key && (
          <section aria-label="Del mismo ticket" className="flex flex-col gap-1">
            <h3 className="px-2 text-[12px] font-medium text-ink-2">
              Del mismo ticket · <span className="font-mono">{key}</span>
            </h3>
            {body(same, "Ninguna otra nota es de este ticket.")}
          </section>
        )}
        <section aria-label="Mencionada en" className="flex flex-col gap-1">
          <h3 className="px-2 text-[12px] font-medium text-ink-2">Mencionada en</h3>
          {body(mention, "Ninguna otra nota la menciona.")}
        </section>
      </div>
    );
  }
  return <footer className="mt-10 border-t border-line pt-5">{content}</footer>;
}
