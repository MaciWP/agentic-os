import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, api, unwrap } from "../../api.ts";
import { createStore } from "../../store.ts";
import { errorText } from "../../ui.tsx";
import { type Doc, deleteDoc, saveDoc, useInvalidateMemory } from "./queries.ts";

// Unsaved text by note, kept while the editor is closed: opening another note, switching to
// reading, or the page redrawing never drops it. A reload of the page asks first.
type Draft = { text: string; base: { body: string; mtime: number } };
const drafts = createStore<ReadonlyMap<string, Draft>>(new Map());
export const hasDraft = (id: string) => drafts.get().has(id);
function keepDraft(id: string, draft: Draft | null) {
  drafts.update((all) => {
    if (!draft && !all.has(id)) return all;
    const next = new Map(all);
    if (draft) next.set(id, draft);
    else next.delete(id);
    return next;
  });
}
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (e) => {
    if (drafts.get().size > 0) e.preventDefault();
  });

// Edits a note of the user's, saving only over the version it opened. `onDeleted` says where to
// go once it is gone; by default the notes page.
export function Editor({ doc, onDeleted }: { doc: Doc; onDeleted?: () => void }) {
  const draft = drafts.get().get(doc.id);
  const [text, setText] = useState(draft?.text ?? doc.body);
  // The version on disk this text started from: what a save must still match.
  const [base, setBase] = useState(draft?.base ?? { body: doc.body, mtime: doc.mtime });
  const [status, setStatus] = useState<{ kind: "saved" | "stale" | "error"; text: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const client = useQueryClient();
  const invalidate = useInvalidateMemory();
  const navigate = useNavigate();
  const dirty = text !== base.body;
  useEffect(() => {
    keepDraft(doc.id, dirty ? { text, base } : null);
  }, [doc.id, dirty, text, base]);

  async function save() {
    setPending(true);
    try {
      const { doc: saved } = await saveDoc(doc.id, text, base.mtime);
      setBase({ body: saved.body, mtime: saved.mtime });
      client.setQueryData(["memory", "doc", doc.id], { doc: saved });
      await invalidate();
      setStatus({ kind: "saved", text: "Guardado." });
    } catch (err) {
      setStatus(
        err instanceof ApiError && err.code === "stale"
          ? {
              kind: "stale",
              text: "El fichero ha cambiado en disco desde que lo abriste. Copia tu texto y recarga para ver la versión nueva.",
            }
          : { kind: "error", text: errorText(err) },
      );
    } finally {
      setPending(false);
    }
  }

  // Drops the user's text for the version on disk; offered only after a stale save.
  async function reload() {
    const fresh = await client.fetchQuery({
      queryKey: ["memory", "doc", doc.id],
      queryFn: async () => unwrap(await api.api.memory.doc.$get({ query: { id: doc.id } })),
    });
    setText(fresh.doc.body);
    setBase({ body: fresh.doc.body, mtime: fresh.doc.mtime });
    setStatus(null);
  }

  async function remove() {
    setPending(true);
    try {
      await deleteDoc(doc.id, base.mtime, base.body);
      keepDraft(doc.id, null);
      await invalidate();
      if (onDeleted) onDeleted();
      else await navigate({ to: "/docs", search: {} });
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <textarea
        aria-label="Contenido"
        className="min-h-[50vh] flex-1 resize-none rounded-md border border-line bg-panel p-3 font-mono text-[13px] leading-relaxed text-ink"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (status?.kind === "saved") setStatus(null);
        }}
      />
      {status && (
        <p
          role={status.kind === "saved" ? "status" : "alert"}
          className={`text-[12px] ${status.kind === "saved" ? "text-ok" : "text-bad"}`}
        >
          {status.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={pending} onClick={save}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
        {status?.kind === "stale" && (
          <button type="button" className="btn" onClick={reload}>
            Recargar
          </button>
        )}
        {dirty && <span className="self-center text-[12px] text-ink-2">Cambios sin guardar</span>}
        <span className="ml-auto flex gap-2">
          {confirmDelete ? (
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn border-bad text-bad"
                disabled={pending}
                onClick={remove}
              >
                Borrar definitivamente
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
              Borrar
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
