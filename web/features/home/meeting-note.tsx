import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Meeting } from "../../../shared/meetings.ts";
import { clockTime } from "../../format.ts";
import { ErrorState, errorText, SkeletonRows } from "../../ui.tsx";
import { Editor } from "../memory/editor.tsx";
import { docQuery, useMemoryDoc } from "../memory/queries.ts";
import { tasksBySource, useObjectiveActions, useTasksBySource } from "../objectives/queries.ts";
import { useMeetingActions } from "../today/queries.ts";
import { checklist, noteSource, pendingLines, tasksFromNote } from "./today-model.ts";

// A meeting's note in Inicio's centre (one Markdown note in Notas per meeting), with the two
// things a meeting ends in: its `- [ ]` lines passed to tasks, and its close. Closing with
// lines not passed asks first and lets the user close anyway.

const SOURCE_NAME = { google: "Google", outlook: "Outlook" } as const;

export function MeetingNoteView({
  meeting,
  noteId,
  onBack,
}: {
  meeting: Meeting;
  noteId: string;
  onBack: () => void;
}) {
  const doc = useMemoryDoc(noteId);
  const made = useTasksBySource(noteSource(meeting.id));
  const act = useObjectiveActions();
  const meet = useMeetingActions();
  const [closed, setClosed] = useState(meeting.closedAt !== null);
  const [warn, setWarn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Read from the saved note: a line typed and not saved yet is not counted.
  const pending =
    doc.data && made.data ? pendingLines(checklist(doc.data.doc.body), made.data.tasks) : [];

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await fn();
      if (done) setMessage({ ok: true, text: done });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const pass = async () => {
    const { tasks } = await act.createMany(tasksFromNote(meeting.id, pending));
    return `${tasks.length === 1 ? "1 tarea pasada" : `${tasks.length} tareas pasadas`} a Hoy.`;
  };
  const close = async () => {
    await meet.close(meeting.id);
    setClosed(true);
    setWarn(false);
    return "Reunión cerrada.";
  };

  const start = new Date(meeting.start);
  return (
    <article
      aria-label={`Nota de ${meeting.title ?? "la reunión"}`}
      className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-5 py-5 md:px-8"
    >
      <div className="flex items-center gap-2 text-[12px] text-ink-2">
        <button type="button" className="btn-ghost -ml-2" onClick={onBack}>
          ← Volver a Hoy
        </button>
      </div>
      <header>
        <h1 className="text-[20px] leading-7 font-semibold text-balance">
          {meeting.title ?? "(sin título)"}
        </h1>
        <p className="text-[12px] text-ink-2">
          {start.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}
          {!meeting.allDay && ` · ${clockTime(meeting.start)}–${clockTime(meeting.end)}`} ·{" "}
          {SOURCE_NAME[meeting.source]}
          {closed && " · cerrada"}
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn text-[12px]"
          disabled={busy || pending.length === 0}
          title="Lee la versión guardada de la nota"
          onClick={() => run(pass)}
        >
          {pending.length === 0 ? "Nada por pasar a tareas" : `Pasar ${pending.length} a tareas`}
        </button>
        {closed ? (
          <button
            type="button"
            className="btn-ghost text-[12px]"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await meet.reopen(meeting.id);
                setClosed(false);
                return "Reunión reabierta.";
              })
            }
          >
            Reabrir reunión
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost text-[12px]"
            disabled={busy}
            onClick={() => (pending.length > 0 ? setWarn(true) : run(close))}
          >
            Cerrar reunión
          </button>
        )}
      </div>
      {warn && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-warn">
            {pending.length === 1
              ? "Queda 1 línea sin pasar a tareas."
              : `Quedan ${pending.length} líneas sin pasar a tareas.`}
          </span>
          <button
            type="button"
            className="btn text-[12px]"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const passed = await pass();
                await close();
                return `${passed} Reunión cerrada.`;
              })
            }
          >
            Pasar y cerrar
          </button>
          <button
            type="button"
            className="btn-ghost text-[12px]"
            disabled={busy}
            onClick={() => run(close)}
          >
            Cerrar igualmente
          </button>
          <button type="button" className="btn-ghost text-[12px]" onClick={() => setWarn(false)}>
            Cancelar
          </button>
        </div>
      )}
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`text-[12px] ${message.ok ? "text-ok" : "text-bad"}`}
        >
          {message.text}
        </p>
      )}
      {doc.isPending ? (
        <SkeletonRows count={6} />
      ) : doc.isError ? (
        <ErrorState error={doc.error} onRetry={() => doc.refetch()} />
      ) : (
        <Editor key={doc.data.doc.id} doc={doc.data.doc} onDeleted={onBack} />
      )}
      {made.isError && (
        <p role="alert" className="text-[12px] text-bad">
          No se han podido leer las tareas de esta reunión: {errorText(made.error)}
        </p>
      )}
    </article>
  );
}

// «Notas» and «Cerrar» on a meeting's row in «Hoy». Closing a meeting whose note still has
// lines not passed to tasks says so first, and lets the user open the note or close anyway.
export function MeetingActions({
  meeting,
  title,
  onNote,
  run,
}: {
  meeting: Meeting;
  title: string;
  onNote: () => void;
  run: (p: Promise<unknown>) => void;
}) {
  const client = useQueryClient();
  const meet = useMeetingActions();
  const [left, setLeft] = useState<number | null>(null);
  const closed = meeting.closedAt !== null;

  // Lines of the note not passed yet; a note that cannot be read holds nothing back.
  const pendingOf = async () => {
    if (!meeting.noteId) return 0;
    try {
      const [doc, made] = await Promise.all([
        client.fetchQuery(docQuery(meeting.noteId)),
        client.fetchQuery(tasksBySource(noteSource(meeting.id))),
      ]);
      return pendingLines(checklist(doc.doc.body), made.tasks).length;
    } catch {
      return 0;
    }
  };

  if (left !== null)
    return (
      <span role="alert" className="flex shrink-0 items-center gap-1 text-[12px]">
        <span className="text-warn">{left} sin pasar</span>
        <button type="button" className="btn-ghost text-[12px]" onClick={onNote}>
          Abrir nota
        </button>
        <button
          type="button"
          className="btn-ghost text-[12px]"
          onClick={() => {
            setLeft(null);
            run(meet.close(meeting.id));
          }}
        >
          Cerrar igualmente
        </button>
      </span>
    );
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        className="btn-ghost text-[12px]"
        aria-label={`Notas de ${title}`}
        onClick={onNote}
      >
        {meeting.noteId ? "Nota" : "Notas"}
      </button>
      <button
        type="button"
        className="btn-ghost text-[12px]"
        aria-label={`${closed ? "Reabrir" : "Cerrar"} ${title}`}
        onClick={() =>
          closed
            ? run(meet.reopen(meeting.id))
            : run(
                pendingOf().then(async (n) => {
                  if (n > 0) setLeft(n);
                  else await meet.close(meeting.id);
                }),
              )
        }
      >
        {closed ? "Reabrir" : "Cerrar"}
      </button>
    </span>
  );
}
