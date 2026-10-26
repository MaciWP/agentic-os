import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { clockTime, plural } from "../../format.ts";
import { ErrorState, SkeletonRows, StaleNotice } from "../../ui.tsx";
import { useNarrow } from "../terminals/mobile.tsx";
import { Capture, SearchBox } from "./desk-capture.tsx";
import { Entry } from "./desk-entry.tsx";
import { DayHead, GroupHead, Hits, TicketHead } from "./desk-lists.tsx";
import { type DeskDocs, type DocsSearch, NOTES_EMPTY, WRITABLE } from "./desk-model.ts";
import { Rail } from "./desk-rail.tsx";
import { isEmptyNote, Reader } from "./desk-reader.tsx";
import { type Filter, matches, useTk } from "./desk-tickets.ts";
import { hasDraft } from "./editor.tsx";
import { dayLabel, type Group, groupByDay, groupByTicket, shortDay } from "./journal.ts";
import { NewDoc, SOURCE_LABEL } from "./panel.tsx";
import {
  HARNESS_SOURCES,
  type SourceId,
  useMemoryDoc,
  useMemorySources,
  useSourcesDocs,
} from "./queries.ts";

// Notas: a desk in three panes. The left rail filters (today, thirteen weeks of activity, the
// tickets the notes name with their Jira status, the sources); the middle lists the notes,
// grouped by ticket or by day, with a quick note on top; the right pane reads the open note as
// Markdown, with the notes of its ticket below. Keys: j/k move, / searches, e edits.

export function NotesDesk({ search }: { search: DocsSearch }) {
  const notes = useSourcesDocs(["notes", "memory"]);
  const prompts = useSourcesDocs(["prompts"]);
  const harness = useSourcesDocs(HARNESS_SOURCES);
  const sources = useMemorySources();
  const lists = [notes, prompts, harness];
  if (lists.some((l) => l.isPending) || sources.isPending) return <SkeletonRows count={6} />;
  const failed = lists.find((l) => l.error)?.error ?? (sources.isError ? sources.error : null);
  const retry = () => {
    for (const l of lists) l.refetch();
    void sources.refetch();
  };
  // Only a list never read replaces the desk: a failed refetch must not unmount an open editor.
  if (failed && (lists.some((l) => !l.hasData) || !sources.data))
    return (
      <div className="p-4">
        <ErrorState error={failed} onRetry={retry} />
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {failed && <StaleNotice error={failed} onRetry={retry} className="m-3 mb-0" />}
      <Desk
        search={search}
        d={{
          notes: notes.docs,
          prompts: prompts.docs,
          harness: harness.docs,
          sources: sources.data?.sources ?? [],
        }}
      />
    </div>
  );
}

function Desk({ search, d }: { search: DocsSearch; d: DeskDocs }) {
  const navigate = useNavigate();
  const tk = useTk();
  const now = Date.now();
  const [filter, setFilter] = useState<Filter>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const q = search.q ?? "";
  const go = (next: Partial<DocsSearch>) =>
    navigate({ to: "/docs", search: { ...search, ...next }, replace: true });
  const openDoc = (id: string | null) => go({ id: id ?? undefined });

  // Por ticket needs the user's tickets to read the keys; without them the list goes by day.
  const byTicket = search.v !== "dia" && tk.jira.state === "ok";
  // The switch shows the grouping on screen; only while the tickets load does it keep the pick.
  const grouping =
    byTicket || (search.v !== "dia" && tk.jira.state === "loading") ? undefined : "dia";
  const all = [...d.notes, ...d.prompts, ...d.harness].sort((a, b) => b.mtime - a.mtime);
  const shown = all.filter((x) => matches(x, filter, tk));
  const groups: Group[] = byTicket ? groupByTicket(shown, (x) => tk.in(x)) : groupByDay(shown);
  const order = [...new Set(groups.flatMap((g) => g.docs.map((x) => x.id)))];
  const open = useMemoryDoc(search.id ?? "").data?.doc;

  // The newest note opens on arrival, so the reading pane is never blank when there is one.
  // Below md the list and the note take turns, so the list stays until one is picked.
  const first = order[0];
  const narrow = useNarrow();
  // biome-ignore lint/correctness/useExhaustiveDependencies: open only when nothing is open
  useEffect(() => {
    if (!search.id && first && !narrow) openDoc(first);
  }, [search.id, first, narrow]);

  // A different note opens in reading view, unless it is still empty or has unsaved text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the opened note only
  useEffect(() => setEditing(open ? isEmptyNote(open) || hasDraft(open.id) : false), [open?.id]);

  // The listener reads the latest list through a ref, so it is attached once.
  const keys = useRef({ order, id: search.id, openDoc, writable: !!open?.writable });
  keys.current = { order, id: search.id, openDoc, writable: !!open?.writable };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { order, id, openDoc, writable } = keys.current;
      if (e.key === "/") {
        e.preventDefault();
        searchBox.current?.focus();
      } else if (e.key === "j" || e.key === "k") {
        const i = id ? order.indexOf(id) : -1;
        const next = order[Math.min(order.length - 1, Math.max(0, e.key === "j" ? i + 1 : i - 1))];
        if (!next || next === id) return;
        openDoc(next);
        list.current
          ?.querySelector(`[data-doc="${CSS.escape(next)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "e" && writable) setEditing((x) => !x);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const filterText =
    filter?.kind === "day"
      ? dayLabel(filter.value, now)
      : filter?.kind === "source"
        ? (SOURCE_LABEL[filter.value as SourceId] ?? filter.value)
        : filter?.value;
  return (
    <div className="flex min-h-0 flex-1">
      <Rail d={d} all={all} now={now} filter={filter} setFilter={setFilter} tk={tk} />
      {/* Below md one column at a time, as in Tickets: the list, or the open note. */}
      <section
        aria-label="Lista de notas"
        className={`${search.id ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-line md:w-[280px] md:border-r lg:w-[360px]`}
      >
        <div className="flex flex-col gap-2 px-3 pt-6 pb-3">
          <h1 className="px-1 text-[20px] font-semibold tracking-[-0.01em] md:hidden">
            Notas y memoria
          </h1>
          <SearchBox q={q} onSearch={(text) => go({ q: text || undefined })} ref={searchBox} />
          <Capture tk={tk} onOpen={openDoc} />
          <div className="flex items-center gap-2">
            <fieldset aria-label="Agrupar" className="flex gap-0.5">
              {(
                [
                  [undefined, "Por ticket"],
                  ["dia", "Por día"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={label}
                  type="button"
                  className="nav-item text-[12px]"
                  aria-pressed={grouping === v}
                  onClick={() => go({ v })}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            <button
              type="button"
              className="btn-ghost ml-auto text-[12px]"
              aria-expanded={creating}
              onClick={() => setCreating(!creating)}
            >
              Nueva nota
            </button>
          </div>
          {creating && (
            <div className="-mx-4">
              <NewDoc sources={WRITABLE} onDone={() => setCreating(false)} onCreated={openDoc} />
            </div>
          )}
          {search.v !== "dia" && tk.jira.state !== "ok" && tk.jira.state !== "loading" && (
            <p className="px-1 text-[11px] text-ink-2">
              Sin tus tickets de Jira no se sabe de qué ticket es cada nota; van por día.
            </p>
          )}
          {filter && !q && (
            <p className="flex items-center gap-2 px-1 text-[12px] text-ink-2">
              <span className="truncate">
                Solo <span className="text-ink first-letter:uppercase">{filterText}</span> ·{" "}
                {plural(shown.length, "nota", "notas")}
              </span>
              <button
                type="button"
                className="btn-ghost ml-auto shrink-0"
                onClick={() => setFilter(null)}
              >
                Quitar filtro
              </button>
            </p>
          )}
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 pb-16">
          {q ? (
            <Hits q={q} open={search.id} onOpen={openDoc} now={now} tk={tk} />
          ) : all.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-ink-2">{NOTES_EMPTY}</p>
          ) : shown.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-ink-2">Ninguna nota con este filtro.</p>
          ) : (
            groups.map((g) => (
              <section key={g.id} aria-label={g.id}>
                <GroupHead count={g.docs.length}>
                  {byTicket ? <TicketHead k={g.id} tk={tk} /> : <DayHead day={g.id} now={now} />}
                </GroupHead>
                <ul className="flex flex-col py-1">
                  {g.docs.map((x) => (
                    <Entry
                      key={x.id}
                      open={search.id}
                      onOpen={openDoc}
                      d={x}
                      when={byTicket ? shortDay(x.mtime, now) : clockTime(x.mtime)}
                      tk={tk}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </section>
      <article
        aria-label="Nota"
        className={`${search.id ? "flex" : "hidden md:flex"} min-w-0 flex-1 overflow-y-auto`}
      >
        <div className="flex w-full max-w-[820px] flex-col px-4 pt-4 pb-16 md:px-6 md:pt-8 lg:px-10">
          <div className="md:hidden">
            <button type="button" className="btn-ghost -ml-2" onClick={() => openDoc(null)}>
              ← Notas
            </button>
          </div>
          <Reader
            id={search.id}
            tk={tk}
            now={now}
            editing={editing}
            setEditing={setEditing}
            onTicket={(k) => {
              go({ q: undefined });
              setFilter({ kind: "ticket", value: k });
            }}
            onOpen={openDoc}
            hasDocs={all.length > 0}
          />
        </div>
      </article>
    </div>
  );
}
