import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { MAX_BRING_NOTES, NOTE_KINDS, type NoteKind } from "../../../shared/terminals.ts";
import { errorText, InlineError } from "../../ui.tsx";
import { HARNESS_LABEL, type TerminalInfo, useTerminals } from "../terminals/queries.ts";
import type { Pick } from "./changes.ts";
import type { DiffLine } from "./diff.ts";
import {
  addNote,
  anchorOf,
  clearSent,
  draftFrom,
  KIND_LABEL,
  type Note,
  type NoteStatus,
  noteStatus,
  PHRASES,
  pendingOf,
  removeNote,
  sendNotes,
  useNotes,
} from "./notes.ts";

// What the diff grids need from the notes: a click on a line number, the lines being picked,
// and what goes under a line (its notes and the open editor).
export type NotesLayer = {
  onLine: (index: number, shift: boolean) => void;
  picked: (index: number) => boolean;
  noted: (index: number) => boolean;
  after: (index: number) => ReactNode;
};

type Edit = { anchor: number; from: number; to: number; kind: NoteKind; text: string };

const STATUS: Record<Exclude<NoteStatus, "pending">, [string, string]> = {
  sent: ["enviada", "text-primary border-primary/40"],
  touched: ["tocada", "text-ok border-ok/40"],
  untouched: ["sin tocar", "text-bad border-bad/40"],
};

// A card spans the whole diff grid, which long lines make wider than the tile: its content
// stays at the scroller's left edge (`@container` in diff-view), as wide as what shows.
const IN_VIEW = "sticky left-0 flex w-[min(100cqw,640px)] flex-col pr-3 pl-4 text-[12.5px]";

const where = (n: { side: "old" | "new"; start: number; end: number }) =>
  `${n.start === n.end ? `línea ${n.start}` : `líneas ${n.start}–${n.end}`}${n.side === "old" ? " (borrada)" : ""}`;

function NoteCard({
  note,
  status,
  onRemove,
}: {
  note: Note;
  status: NoteStatus;
  onRemove: () => void;
}) {
  const [label, tone] = status === "pending" ? [null, ""] : STATUS[status];
  return (
    <div
      data-note={note.id}
      className={`col-span-full border-y border-warn/25 bg-warn/5 font-sans ${status === "pending" ? "" : "opacity-80"}`}
    >
      <div className={`${IN_VIEW} gap-1 py-1.5`}>
        <span className="flex items-center gap-2 font-mono text-[11px] text-warn">
          <span className="rounded bg-warn/15 px-1.5">{KIND_LABEL[note.kind]}</span>
          {where(note)}
          {label && (
            <span
              className={`rounded-full border px-1.5 ${tone}`}
              title={
                status === "touched"
                  ? "Esas líneas ya no están igual en el diff: el agente las cambió. Si el cambio es el correcto lo decides tú."
                  : status === "untouched"
                    ? "Esas líneas siguen igual en el diff."
                    : undefined
              }
            >
              {label}
            </span>
          )}
          <button
            type="button"
            className="ml-auto text-ink-2 hover:text-ink"
            aria-label={`Borrar la nota de ${where(note)}`}
            onClick={onRemove}
          >
            Borrar
          </button>
        </span>
        <p className="whitespace-pre-wrap text-ink">{note.text}</p>
      </div>
    </div>
  );
}

function NoteEditor({
  edit,
  label,
  onEdit,
  onSave,
  onCancel,
}: {
  edit: Edit;
  label: string;
  onEdit: (e: Edit) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // Focus once when the editor opens on a line, not on each keystroke or range change.
  useEffect(() => box.current?.focus(), []);
  return (
    <div className="col-span-full border-y border-warn/40 bg-warn/5 font-sans">
      <div className={`${IN_VIEW} gap-1.5 py-2`}>
        <span className="font-mono text-[11px] text-warn">
          Nueva nota · {label}
          {edit.from === edit.to && " · Mayús+clic en otra línea del bloque para un rango"}
        </span>
        <fieldset aria-label="Tipo de nota" className="flex flex-wrap gap-1">
          {NOTE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={edit.kind === k}
              className={`rounded-full border px-2 text-[11.5px] ${edit.kind === k ? "border-warn bg-warn font-semibold text-[var(--on-accent)]" : "border-line text-ink-2 hover:text-ink"}`}
              onClick={() => onEdit({ ...edit, kind: k })}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </fieldset>
        <textarea
          ref={box}
          aria-label="Texto de la nota"
          placeholder="¿Qué debe hacer el agente aquí?"
          maxLength={2000}
          rows={2}
          value={edit.text}
          className="w-full min-w-0 resize-y rounded border border-warn/60 bg-bg px-2 py-1 text-[12.5px]"
          onChange={(e) => onEdit({ ...edit, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <fieldset className="flex flex-wrap gap-1" aria-label="Frases rápidas">
          {PHRASES.map((p) => (
            <button
              key={p}
              type="button"
              className="rounded border border-line border-dashed px-1.5 text-[11.5px] text-ink-2 hover:text-ink"
              onClick={() => {
                onEdit({ ...edit, text: edit.text.trim() ? `${edit.text.trim()} ${p}` : p });
                box.current?.focus();
              }}
            >
              {p.replace(/\.$/, "")}
            </button>
          ))}
        </fieldset>
        <div className="flex gap-1.5">
          <button
            type="button"
            className="btn btn-primary h-6 text-[12px]"
            disabled={!edit.text.trim()}
            onClick={onSave}
          >
            Guardar nota
          </button>
          <button type="button" className="btn h-6 text-[12px]" onClick={onCancel}>
            Descartar
          </button>
          <span className="self-center text-[11px] text-ink-2">⌘↵ guarda · Esc descarta</span>
        </div>
      </div>
    </div>
  );
}

// An agent that can take the notes: running, in this checkout, not a shell or an env command.
const takesNotes = (t: TerminalInfo, location: string) =>
  t.location === location && t.state === "running" && t.harness !== "shell" && t.harness !== "env";
const terminalLabel = (t: TerminalInfo) => t.name ?? HARNESS_LABEL[t.harness];

// «N notas · Enviar a ▾»: every pending note of the checkout goes in one paste, never followed
// by Enter. Sent ones stay to show whether the agent touched their lines, until cleared.
function SendBar({ location, notes }: { location: string; notes: readonly Note[] }) {
  const terminals = useTerminals();
  const agents = useMemo(
    () => (terminals.data?.terminals ?? []).filter((t) => takesNotes(t, location)),
    [terminals.data, location],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const target = agents.find((t) => t.id === chosen) ?? agents[0];
  const send = useMutation({
    mutationFn: (id: string) => sendNotes(location, id),
  });
  const pending = pendingOf(notes).length;
  const sent = notes.length - pending;
  if (notes.length === 0) return null;
  const files = new Set(pendingOf(notes).map((n) => n.path)).size;
  const reason = terminals.isError
    ? "no se pudo leer la lista de terminales"
    : agents.length === 0
      ? "no hay ningún agente en marcha en este checkout"
      : null;
  return (
    <section
      aria-label="Notas del diff"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-[var(--hover)] px-3 py-1.5 text-[12px]"
    >
      <span className="font-mono font-medium text-warn">
        {pending === 1 ? "1 nota" : `${pending} notas`}
      </span>
      <span className="text-ink-2">
        {pending ? `en ${files} ${files === 1 ? "fichero" : "ficheros"}` : "todo enviado"}
        {pending > MAX_BRING_NOTES && ` · se envían las ${MAX_BRING_NOTES} primeras`}
      </span>
      {sent > 0 && (
        <button
          type="button"
          className="text-ink-2 hover:text-ink"
          onClick={() => clearSent(location)}
        >
          Limpiar enviadas
        </button>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {reason ? (
          <span className="text-ink-2">{reason}</span>
        ) : (
          <>
            <label htmlFor={`notes-to-${location}`} className="text-ink-2">
              Enviar a
            </label>
            <select
              id={`notes-to-${location}`}
              className="btn h-6 max-w-[200px] text-[12px]"
              value={target?.id ?? ""}
              onChange={(e) => setChosen(e.target.value)}
            >
              {agents.map((t) => (
                <option key={t.id} value={t.id}>
                  {terminalLabel(t)}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          className="btn btn-primary h-6 text-[12px]"
          disabled={!target || pending === 0 || send.isPending}
          onClick={() => target && send.mutate(target.id)}
        >
          {pending ? `Enviar ${Math.min(pending, MAX_BRING_NOTES)}` : "Nada que enviar"}
        </button>
      </span>
      {send.error && (
        <InlineError as="span" className="basis-full">
          {errorText(send.error)}
        </InlineError>
      )}
    </section>
  );
}

// Notes for one file's diff: the layer the grids draw, the notes whose lines left the diff
// (shown above it) and the send bar (below it).
export function useDiffNotes(location: string, pick: Pick, lines: readonly DiffLine[]) {
  const all = useNotes(location);
  const [edit, setEdit] = useState<Edit | null>(null);
  const mine = useMemo(
    () => all.filter((n) => n.path === pick.path && n.staged === pick.staged),
    [all, pick.path, pick.staged],
  );
  const placed = useMemo(
    () =>
      mine.map((note) => ({ note, end: anchorOf(note, lines), status: noteStatus(note, lines) })),
    [mine, lines],
  );
  // A switch of file closes the editor: its indices belong to the other diff.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is the point of the deps
  useEffect(() => setEdit(null), [pick.path, pick.staged]);

  const draft = edit && draftFrom(lines, edit.from, edit.to);
  const save = () => {
    if (!edit || !draft || !edit.text.trim()) return;
    addNote(location, {
      path: pick.path,
      staged: pick.staged,
      ...draft,
      kind: edit.kind,
      text: edit.text.trim(),
    });
    setEdit(null);
  };
  const hunkOf = (i: number) => lines[i]?.hunk ?? null;

  const layer: NotesLayer = {
    onLine(i, shift) {
      if (shift && edit && hunkOf(i) === hunkOf(edit.anchor)) {
        const from = Math.min(edit.anchor, i);
        const to = Math.max(edit.anchor, i);
        if (draftFrom(lines, from, to)) return setEdit({ ...edit, from, to });
      }
      if (draftFrom(lines, i, i)) setEdit({ anchor: i, from: i, to: i, kind: "change", text: "" });
    },
    picked: (i) => !!edit && i >= edit.from && i <= edit.to,
    noted: (i) => placed.some((p) => p.end >= 0 && i <= p.end && i > p.end - p.note.lines.length),
    after(i) {
      const here = placed.filter((p) => p.end === i);
      const open = edit?.to === i && draft;
      if (here.length === 0 && !open) return null;
      return (
        <>
          {here.map((p) => (
            <NoteCard
              key={p.note.id}
              note={p.note}
              status={p.status}
              onRemove={() => removeNote(location, p.note.id)}
            />
          ))}
          {open && edit && (
            <NoteEditor
              edit={edit}
              label={where(draft)}
              onEdit={setEdit}
              onSave={save}
              onCancel={() => setEdit(null)}
            />
          )}
        </>
      );
    },
  };

  const gone = placed.filter((p) => p.end < 0);
  const top =
    gone.length > 0 ? (
      <section aria-label="Notas sobre líneas que ya no están" className="border-b border-line">
        <p className="px-3 py-1 text-[11.5px] text-ink-2">
          Notas sobre líneas que ya no están en este diff
        </p>
        {gone.map((p) => (
          <NoteCard
            key={p.note.id}
            note={p.note}
            status={p.status}
            onRemove={() => removeNote(location, p.note.id)}
          />
        ))}
      </section>
    ) : null;

  return { layer, top, bar: <SendBar location={location} notes={all} /> };
}
