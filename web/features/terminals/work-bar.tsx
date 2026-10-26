import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  type BarButton,
  FRONTMATTER,
  frontmatterFields,
  PROMPT_VARIABLES,
  variablesIn,
  withBody,
  withField,
} from "../../../shared/work-bar.ts";
import { Icon } from "../../icons.tsx";
import { errorText, Modal } from "../../ui.tsx";
import { field } from "../coordination/queries.ts";
import {
  type Doc,
  saveDoc,
  useInvalidateMemory,
  useMemoryDoc,
  useWorkBar,
} from "../memory/queries.ts";
import { startBring } from "./bring.ts";

// A ritual opened from the bar: what it sends, edited in place. The button's name, its
// description and the text are saved back to the saved prompt, the rest of its frontmatter
// kept; a file changed since it was read is refused (409 stale), so nothing is lost.
function RitualEditor({ button, onClose }: { button: BarButton; onClose: () => void }) {
  const doc = useMemoryDoc(button.id);
  const loaded = doc.data?.doc;
  return (
    <Modal title={`Ritual «${button.label ?? button.title}»`} onClose={onClose}>
      {doc.isError ? (
        <p className="p-4 text-[13px] text-bad">
          No se pudo leer el prompt.{" "}
          <button type="button" className="btn" onClick={() => doc.refetch()}>
            Reintentar
          </button>
        </p>
      ) : loaded ? (
        <RitualForm key={loaded.mtime} doc={loaded} onClose={onClose} />
      ) : (
        <p className="p-4 text-[13px] text-ink-2">Cargando…</p>
      )}
    </Modal>
  );
}

function RitualForm({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const invalidate = useInvalidateMemory();
  const fields = Object.fromEntries(frontmatterFields(doc.body));
  const [label, setLabel] = useState(fields.label ?? "");
  const [description, setDescription] = useState(fields.description ?? "");
  const [body, setBody] = useState(doc.body.replace(FRONTMATTER, ""));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  // The cursor starts at the end, where something added most often goes.
  useEffect(() => {
    const end = text.current?.value.length ?? 0;
    text.current?.setSelectionRange(end, end);
  }, []);
  const used = variablesIn(body);
  const changed =
    label !== (fields.label ?? "") ||
    description !== (fields.description ?? "") ||
    body !== doc.body.replace(FRONTMATTER, "");
  // A variable goes in at the cursor, as the drop will fill it.
  const insert = (name: string) => {
    const el = text.current;
    const at = el?.selectionStart ?? body.length;
    const to = el?.selectionEnd ?? at;
    const token = `{{${name}}}`;
    setBody(body.slice(0, at) + token + body.slice(to));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  const save = async () => {
    setPending(true);
    try {
      let next = withField(doc.body, "label", label);
      next = withField(next, "description", description);
      await saveDoc(doc.id, withBody(next, body), doc.mtime);
      await invalidate();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <form
      className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-ink-2">Nombre del botón</span>
        <input
          className={field}
          value={label}
          maxLength={40}
          placeholder={doc.title}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-ink-2">Qué hace</span>
        <input
          className={field}
          value={description}
          placeholder="Una línea para el tooltip"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-ink-2">Lo que se envía al agente</span>
        <textarea
          ref={text}
          data-autofocus
          className={`${field} min-h-48 resize-y font-mono text-[12px] leading-relaxed`}
          rows={12}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-ink-2">Añadir dato de la terminal:</span>
        {PROMPT_VARIABLES.map((v) => (
          <button
            key={v}
            type="button"
            className={`pill h-6 px-2 font-mono text-[11px] ${used.includes(v) ? "border-primary text-primary" : "text-ink-2"}`}
            title={`Inserta {{${v}}}: al soltarlo se cambia por ${VARIABLE_TEXT[v]}`}
            onClick={() => insert(v)}
          >
            {`{{${v}}}`}
          </button>
        ))}
      </div>
      {error && <p className="text-[12px] text-bad">{error}</p>}
      <div className="flex items-center gap-2">
        <Link to="/docs" search={{ id: doc.id }} className="btn-ghost text-[12px]">
          Abrir en Prompts
        </Link>
        <button type="button" className="btn ml-auto" onClick={onClose}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={!changed || pending}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </form>
  );
}

const VARIABLE_TEXT: Record<(typeof PROMPT_VARIABLES)[number], string> = {
  ticket: "el ticket de la terminal",
  objective: "su objetivo",
  branch: "la rama de su carpeta",
  cwd: "su carpeta",
  location: "su ubicación",
};

// The work bar: the user's rituals, saved prompts marked «En la barra», in their own row over
// the Mesa. Each is dragged onto an agent's tile and sent there with its ticket, objective and
// branch filled in. Drag only, so it is not on a phone.
export function WorkBar() {
  const q = useWorkBar();
  const [open, setOpen] = useState<BarButton | null>(null);
  const buttons = q.data?.buttons;
  if (!q.isError && !buttons) return null;
  return (
    <div className="hidden shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1.5 md:flex">
      <span className="shrink-0 font-semibold text-[11px] text-ink-2 uppercase tracking-wide">
        Rituales
      </span>
      {q.isError ? (
        <span className="flex items-center gap-2 text-[12px] text-bad">
          La barra no carga
          <button type="button" className="btn" onClick={() => q.refetch()}>
            Reintentar
          </button>
        </span>
      ) : buttons?.length ? (
        <ul
          aria-label="Barra de trabajo"
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
        >
          {buttons.map((b) => (
            <li key={b.id} className="shrink-0">
              <button
                type="button"
                draggable
                onDragStart={startBring({ prompt: b.id })}
                // A double click, or Enter or Space (detail 0), shows what it sends; one click
                // does nothing, so grabbing it to drag never opens it.
                onClick={(e) => {
                  if (e.detail === 0 || e.detail === 2) setOpen(b);
                }}
                aria-label={`Ritual ${b.label ?? b.title}: doble clic o Intro para ver y editar lo que envía`}
                title={`${b.description ?? b.title}. Doble clic para ver y editar lo que envía; arrástralo a un agente libre para enviárselo.`}
                className="pill h-6 cursor-grab gap-1.5 bg-bg px-2.5 text-[12px] text-ink hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
              >
                <span aria-hidden className="drag-grip" />
                {b.label ?? b.title}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="flex-1 text-[12px] text-ink-2">
          Sin rituales: marca un prompt «En la barra»
        </span>
      )}
      <Link
        to="/docs"
        title="Crea o edita rituales en Prompts y márcalos «En la barra»"
        className="btn-ghost ml-auto shrink-0 gap-1 text-[12px]"
      >
        <Icon name="plus" size={12} />
        Ritual
      </Link>
      {open && <RitualEditor button={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
