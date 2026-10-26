import { useState } from "react";
import { barOf, withBar } from "../../../shared/work-bar.ts";
import { ApiError } from "../../api.ts";
import { ErrorState, errorText, SkeletonRows, StaleNotice } from "../../ui.tsx";
import { Related } from "./desk-lists.tsx";
import { ago } from "./desk-model.ts";
import { TicketMark } from "./desk-rail.tsx";
import type { Tk } from "./desk-tickets.ts";
import { Editor, hasDraft } from "./editor.tsx";
import { withoutTitle } from "./journal.ts";
import { SOURCE_LABEL } from "./panel.tsx";
import { Prose } from "./prose.tsx";
import { type Doc, saveDoc, useInvalidateMemory, useMemoryDoc } from "./queries.ts";

// A note that is just its heading opens in the editor: there is nothing to read yet.
export const isEmptyNote = (d: Doc) =>
  d.writable && d.body.replace(/^#[^\n]*\n?/, "").trim() === "";

// A saved prompt in the Mesa's work bar, or out of it: rewrites its `bar:` field on disk. A
// file changed since it was read is refused (409 stale), so nothing is lost.
function BarToggle({ doc }: { doc: Doc }) {
  const invalidate = useInvalidateMemory();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = barOf(doc.body).bar;
  return (
    <button
      type="button"
      className={`btn ${error ? "text-bad" : ""}`}
      aria-pressed={on}
      disabled={pending}
      title={error ?? (on ? "Quitarlo de la barra de la Mesa" : "Ponerlo en la barra de la Mesa")}
      onClick={async () => {
        setPending(true);
        try {
          await saveDoc(doc.id, withBar(doc.body, !on), doc.mtime);
          setError(null);
          await invalidate();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setPending(false);
        }
      }}
    >
      {on ? "En la barra ✓" : "En la barra"}
    </button>
  );
}

export function Reader({
  id,
  tk,
  now,
  editing,
  setEditing,
  onTicket,
  onOpen,
  hasDocs,
}: {
  id: string | undefined;
  tk: Tk;
  now: number;
  editing: boolean;
  setEditing: (on: boolean) => void;
  onTicket: (k: string) => void;
  onOpen: (id: string | null) => void;
  hasDocs: boolean;
}) {
  const q = useMemoryDoc(id ?? "");
  if (!id)
    return (
      <p className="grid h-full place-items-center text-[13px] text-ink-2">
        {hasDocs
          ? "Elige una nota, o muévete con j y k."
          : "Lo que apuntes aparece aquí, ya formateado."}
      </p>
    );
  if (!q.data) {
    if (q.isPending) return <SkeletonRows count={6} />;
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <p role="alert" className="text-ink-2">
          Ese documento ya no existe o no se puede abrir.
        </p>
      );
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }
  const doc = q.data.doc;
  const keys = tk.in(doc);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A failed background refetch keeps the open note, so unsaved text survives. */}
      {q.isError && (
        <StaleNotice error={q.error} className="mb-4">
          No se pudo comprobar si la nota ha cambiado
        </StaleNotice>
      )}
      <header className="flex flex-col gap-2 pb-6">
        <div className="flex items-start gap-3">
          <p
            className="min-w-0 truncate pt-1 text-[12px] text-ink-2"
            title={`${SOURCE_LABEL[doc.source]} · ${doc.rel} · ${ago(doc, now)}`}
          >
            {SOURCE_LABEL[doc.source]} · <span className="font-mono">{doc.rel}</span> ·{" "}
            {ago(doc, now)}
          </p>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {doc.writable && !editing && hasDraft(doc.id) && (
              <span className="pill text-warn" title="Pulsa Editar para recuperarlos">
                Cambios sin guardar
              </span>
            )}
            {doc.writable && doc.source === "prompts" && !editing && <BarToggle doc={doc} />}
            {doc.writable ? (
              <button
                type="button"
                className="btn"
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
                title="Atajo: e"
              >
                {editing ? "Leer" : "Editar"}
              </button>
            ) : (
              <span
                className="pill text-ink-2"
                title="Es memoria de un harness: la app la muestra pero nunca la modifica"
              >
                Solo lectura
              </span>
            )}
          </span>
        </div>
        <h1
          title={doc.title}
          className="line-clamp-3 text-[24px] leading-tight font-semibold tracking-[-0.015em] text-balance"
        >
          {doc.title}
        </h1>
        {doc.description && <p className="text-[14px] text-ink-2">{doc.description}</p>}
        {keys.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {keys.map((k) => {
              const t = tk.of(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => onTicket(k)}
                  title={`Ver las notas de ${k}`}
                  className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] hover:bg-[var(--hover)]"
                >
                  <TicketMark k={k} t={t} />
                  <span className="shrink-0 font-mono whitespace-nowrap">{k}</span>
                  <span
                    className="truncate text-ink-2"
                    title={t ? `${t.status.name} · ${t.summary}` : tk.absent}
                  >
                    {t ? `${t.status.name} · ${t.summary}` : tk.absent}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </header>
      {editing && doc.writable ? (
        // Its own block, so the editor keeps its full height above the related notes.
        <div className="flex flex-col">
          <Editor key={doc.id} doc={doc} onDeleted={() => onOpen(null)} />
        </div>
      ) : (
        <Prose text={withoutTitle(doc.body, doc.title)} />
      )}
      <Related doc={doc} keys={keys} tk={tk} now={now} onOpen={onOpen} />
    </div>
  );
}
