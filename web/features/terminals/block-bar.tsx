import { type RefObject, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { BLOCK_COLORS, type BlockColor } from "../../../shared/workspace.ts";
import { addBlock, dropBlock, editBlock, mergeProposal, type Proposal } from "./mesa-blocks.ts";
import { readMesas } from "./mesas.ts";
import { sendIntent } from "./workspace-sync.tsx";

// A block goes; its Mesas stay, out of any block.
export const removeBlock = (id: string) =>
  sendIntent({ kind: "block-remove", block: id }, (s) => dropBlock(s, id));

const COLOR_NAMES: Record<BlockColor, string> = {
  slate: "Gris",
  blue: "Azul",
  green: "Verde",
  amber: "Ámbar",
  rose: "Rosa",
  violet: "Violeta",
};

function Swatches({ value, onPick }: { value: BlockColor; onPick: (c: BlockColor) => void }) {
  return (
    <div className="flex gap-1">
      {BLOCK_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          data-block={c}
          aria-label={`Color ${COLOR_NAMES[c]}`}
          aria-pressed={value === c}
          title={COLOR_NAMES[c]}
          onClick={() => onPick(c)}
          className={`grid size-7 place-items-center rounded hover:bg-[var(--hover)] ${value === c ? "bg-[var(--selected)] ring-1 ring-primary" : ""}`}
        >
          <span className="size-3 rounded-full bg-[var(--blk)]" />
        </button>
      ))}
    </div>
  );
}

// What the block popover edits: a new block (id not in the workspace yet) or an existing one.
// `mesa` is the Mesa a new block takes in.
export type BlockEditing = {
  id: string;
  name: string;
  color: BlockColor;
  mesa?: string;
  isNew: boolean;
};

export function BlockEditor({
  editing,
  onEditing,
  anchor,
}: {
  editing: BlockEditing | null;
  onEditing: (editing: BlockEditing | null) => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const nameField = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    onEditing(null);
  };
  const save = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    if (!name || name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name))
      return setError("Nombre no válido: de 1 a 40 caracteres, sin caracteres invisibles.");
    if (editing.isNew) {
      const block = { id: editing.id, name, color: editing.color };
      const mesas = editing.mesa ? [editing.mesa] : [];
      sendIntent({ kind: "block-create", block: block.id, name, color: block.color, mesas }, (s) =>
        addBlock(s, block, mesas),
      );
    } else {
      const was = readMesas().blocks?.find((b) => b.id === editing.id);
      if (was && (was.name !== name || was.color !== editing.color))
        sendIntent({ kind: "block-update", block: editing.id, name, color: editing.color }, (s) =>
          editBlock(s, editing.id, { name, color: editing.color }),
        );
    }
    close();
  };
  const remove = () => {
    if (!editing) return;
    removeBlock(editing.id);
    close();
  };

  return (
    <Popover open={editing !== null} onOpenChange={(open) => !open && close()}>
      <PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />
      <PopoverContent
        align="start"
        className="w-80"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameField.current?.focus();
          nameField.current?.select();
        }}
        // Opened from «Mover a bloque», the closing submenu hands the focus back to its
        // unmounting trigger, and that focus leaving would close the editor at once. A click
        // outside or Esc still close it.
        onFocusOutside={(e) => e.preventDefault()}
      >
        {editing && (
          <form
            aria-label={editing.isNew ? "Nuevo bloque" : "Editar bloque"}
            className="flex flex-col gap-2 text-[12px]"
            onSubmit={save}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-ink-2">Nombre del bloque</span>
              <input
                ref={nameField}
                aria-label="Nombre del bloque"
                className="min-w-0 rounded border border-line px-2 py-1"
                placeholder="Trabajo, Personal…"
                value={editing.name}
                maxLength={40}
                onChange={(e) => {
                  setError(null);
                  onEditing({ ...editing, name: e.target.value });
                }}
              />
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-ink-2">Color</legend>
              <Swatches
                value={editing.color}
                onPick={(color) => onEditing({ ...editing, color })}
              />
            </fieldset>
            {error && (
              <p role="alert" className="text-bad">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              {!editing.isNew && (
                <button
                  type="button"
                  className="btn-ghost mr-auto"
                  title="Sus Mesas se quedan, sin bloque"
                  onClick={remove}
                >
                  Borrar bloque
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={close}>
                Cancelar
              </button>
              <button type="submit" className="btn">
                {editing.isNew ? "Crear" : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

// «Organizar por proyecto»: the proposed blocks, each renamed, recoloured or merged into
// another before «Aplicar» creates them.
export function OrganizeBlocks({
  proposal,
  onProposal,
  anchor,
  mesaLabel,
}: {
  proposal: Proposal[] | null;
  onProposal: (proposal: Proposal[] | null) => void;
  anchor: RefObject<HTMLElement | null>;
  mesaLabel: (id: string) => string;
}) {
  const apply = () => {
    for (const p of proposal ?? []) {
      const name = p.name.trim().slice(0, 40) || p.key.slice(0, 40);
      const block = { id: crypto.randomUUID(), name, color: p.color };
      sendIntent(
        { kind: "block-create", block: block.id, name, color: p.color, mesas: p.mesas },
        (s) => addBlock(s, block, p.mesas),
      );
    }
    onProposal(null);
  };
  const change = (key: string, patch: Partial<Proposal>) =>
    onProposal((proposal ?? []).map((p) => (p.key === key ? { ...p, ...patch } : p)));

  return (
    <Popover open={proposal !== null} onOpenChange={(open) => !open && onProposal(null)}>
      <PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />
      <PopoverContent align="end" className="w-96 text-[12px]">
        {proposal && (
          <section
            aria-label="Organizar por proyecto"
            className="flex flex-col gap-3"
            onKeyDown={(e) => e.stopPropagation()}
          >
            <p className="text-ink-2">
              {proposal.length
                ? "Bloques propuestos según el proyecto de cada Mesa. Renombra, cambia el color o une bloques antes de aplicar."
                : "Ninguna Mesa sin bloque trabaja en un proyecto configurado."}
            </p>
            {proposal.map((p) => (
              <div
                key={p.key}
                data-block={p.color}
                className="flex flex-col gap-1.5 border-[var(--blk)] border-l-2 pl-2"
              >
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`Nombre del bloque ${p.key}`}
                    className="min-w-0 flex-1 rounded border border-line px-2 py-1"
                    value={p.name}
                    maxLength={40}
                    onChange={(e) => change(p.key, { name: e.target.value })}
                  />
                  {proposal.length > 1 && (
                    <select
                      aria-label={`Unir ${p.name} con`}
                      className="rounded border border-line bg-panel px-1 py-1"
                      value=""
                      onChange={(e) =>
                        e.target.value && onProposal(mergeProposal(proposal, p.key, e.target.value))
                      }
                    >
                      <option value="">Unir con…</option>
                      {proposal
                        .filter((x) => x.key !== p.key)
                        .map((x) => (
                          <option key={x.key} value={x.key}>
                            {x.name}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
                <Swatches value={p.color} onPick={(color) => change(p.key, { color })} />
                <ul className="flex flex-wrap gap-1" aria-label={`Mesas de ${p.name}`}>
                  {p.mesas.map((id) => (
                    <li
                      key={id}
                      className="max-w-40 truncate rounded bg-[var(--hover)] px-1.5 py-0.5 text-ink-2"
                    >
                      {mesaLabel(id)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => onProposal(null)}>
                Cancelar
              </button>
              <button type="button" className="btn" disabled={!proposal.length} onClick={apply}>
                Aplicar
              </button>
            </div>
          </section>
        )}
      </PopoverContent>
    </Popover>
  );
}
