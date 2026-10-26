import { useState } from "react";
import { Icon } from "../../icons.tsx";
import { InlineError, Modal } from "../../ui.tsx";
import { FolderPicker } from "../files/folder-picker.tsx";
import type { FolderEntry, Listing } from "../files/queries.ts";
import { gitErrorText } from "../git/queries.ts";
import { useShowNode } from "../terminals/node-link.tsx";
import { useAddRepo, useProjects, useRemoveRepo } from "./queries.ts";

// "Añadir repo" at the foot of «Otros proyectos»: the app's folder picker, and the folder chosen joins the tree as a repo. The picker allows only a git root not on
// the list yet; the server still refuses in words what cannot be one (inside another repo).
const noop = () => {};

export function AddRepo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-3 pb-2">
      <button
        type="button"
        className="btn-ghost gap-1 text-[12px]"
        title="Elige una carpeta con un repo de git"
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" size={13} />
        Añadir repo
      </button>
      {open && (
        <Modal title="Añadir repo" onClose={() => setOpen(false)}>
          <AddRepoPicker onDone={() => setOpen(false)} />
        </Modal>
      )}
    </div>
  );
}

function AddRepoPicker({ onDone }: { onDone: () => void }) {
  const add = useAddRepo();
  const showNode = useShowNode();
  const added = new Set(
    (useProjects().data?.repos ?? []).flatMap((r) => (r.main ? [r.main.path] : [])),
  );
  const check = (l: Listing) =>
    !l.git ? "Elige la raíz de un repo de git." : added.has(l.path) ? "Ya está en la lista." : null;
  const mark = (e: FolderEntry) =>
    added.has(e.path) ? (
      <span className="pill">ya añadido</span>
    ) : e.git ? (
      <span className="pill">git</span>
    ) : null;
  // The awaited promise, not mutate's callbacks: the push after the write re-renders first.
  const pick = (path: string) =>
    add.mutateAsync({ path }).then((r) => {
      onDone();
      showNode(r.location);
    }, noop);
  return (
    <FolderPicker
      check={check}
      mark={mark}
      action="Añadir este repo"
      busy={add.isPending}
      error={add.error}
      onPick={pick}
      onCancel={onDone}
    />
  );
}

// In an added repo's "⋯": off the list, the folder untouched.
export function RemoveRepo({ id }: { id: string }) {
  const remove = useRemoveRepo();
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={remove.isPending}
        title="Lo quita del árbol; la carpeta queda como está"
        onClick={() => remove.mutate(id)}
      >
        Quitar de la lista
      </button>
      {remove.error && (
        <InlineError as="span" className="text-[11px]">
          {gitErrorText(remove.error)}
        </InlineError>
      )}
    </>
  );
}
