import { type RefObject, useRef } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { isMacClient } from "../../keys.ts";
import { activeMesa, isEmoji, readMesas, renameMesa, type Workspace } from "./mesas.ts";
import { sendIntent } from "./workspace-sync.tsx";

const SUGGESTED = ["🐛", "🚀", "🔍", "🧪", "🛠️", "📝", "🔥", "💡", "📦", "⭐"];

export type Editing = { id: string; name: string; icon: string | null; error: string | null };

// The popover that renames a Mesa and sets its icon, opened from a tab or from "⋯".
export function MesaRename({
  editing,
  onEditing,
  anchor,
  placeholder,
}: {
  editing: Editing | null;
  onEditing: (editing: Editing | null) => void;
  anchor: RefObject<HTMLElement | null>;
  // The name the Mesa takes when the field is left empty.
  placeholder: string;
}) {
  const nameField = useRef<HTMLInputElement>(null);
  const save = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!editing) return;
    if (editing.icon && !isEmoji(editing.icon))
      return onEditing({ ...editing, error: "El icono tiene que ser un solo emoji." });
    // renameMesa returns the same workspace when it refuses the name.
    const rename = (s: Workspace) => renameMesa(s, editing.id, editing.name, editing.icon);
    const before = readMesas();
    const after = rename(before);
    if (after === before && editing.name.trim() !== "")
      return onEditing({
        ...editing,
        error: "Nombre no válido: hasta 40 caracteres, sin caracteres invisibles.",
      });
    const name = activeMesa(after, editing.id).name;
    if (name !== activeMesa(before, editing.id).name)
      sendIntent({ kind: "rename", mesa: editing.id, name }, rename);
    onEditing(null);
  };

  return (
    <Popover open={editing !== null} onOpenChange={(open) => !open && onEditing(null)}>
      <PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />
      <PopoverContent
        align="start"
        className="w-80"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameField.current?.focus();
          nameField.current?.select();
        }}
      >
        {editing && (
          <form
            className="flex flex-col gap-2 text-[12px]"
            onSubmit={save}
            onKeyDown={(e) => {
              // Keys typed here never reach the Mesa's or the app's shortcuts.
              e.stopPropagation();
              if (e.key === "Escape") onEditing(null);
            }}
          >
            <fieldset className="flex flex-wrap items-center gap-1">
              <legend className="mb-1 text-ink-2">Icono</legend>
              {SUGGESTED.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`Icono ${emoji}`}
                  aria-pressed={editing.icon === emoji}
                  className={`grid size-7 place-items-center rounded text-[15px] hover:bg-[var(--hover)] ${editing.icon === emoji ? "bg-[var(--selected)] ring-1 ring-primary" : ""}`}
                  onClick={() => onEditing({ ...editing, icon: emoji, error: null })}
                >
                  {emoji}
                </button>
              ))}
              <input
                aria-label="Icono de la Mesa"
                title={
                  isMacClient()
                    ? "Cualquier emoji: ⌃⌘Espacio abre el selector del Mac"
                    : "Cualquier emoji: Win+. abre el selector de Windows"
                }
                placeholder="🙂"
                className="w-12 rounded border border-line px-1 py-1 text-center text-[15px]"
                maxLength={16}
                value={editing.icon ?? ""}
                onChange={(e) =>
                  onEditing({ ...editing, icon: e.target.value.trim() || null, error: null })
                }
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={!editing.icon}
                onClick={() => onEditing({ ...editing, icon: null, error: null })}
              >
                Sin icono
              </button>
            </fieldset>
            <label className="flex flex-col gap-1">
              <span className="text-ink-2">Nombre</span>
              <input
                ref={nameField}
                aria-label="Nombre de la Mesa"
                className="min-w-0 rounded border border-line px-2 py-1"
                placeholder={placeholder}
                value={editing.name}
                maxLength={40}
                onChange={(e) => onEditing({ ...editing, name: e.target.value, error: null })}
              />
            </label>
            <p className="text-[11px] text-ink-2">
              Vacío: la Mesa toma el ticket o la tarea de sus terminales.
            </p>
            {editing.error && (
              <p role="alert" className="text-bad">
                {editing.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => onEditing(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn">
                Guardar
              </button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
