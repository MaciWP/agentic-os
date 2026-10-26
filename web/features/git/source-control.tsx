import { useState } from "react";
import { plural } from "../../format.ts";
import { InlineError, Modal } from "../../ui.tsx";
import { Group } from "./change-rows.tsx";
import { groups, type Pick } from "./changes.ts";
import { CommitBox } from "./commit-box.tsx";
import { noteCounts, useNotes } from "./notes.ts";
import { type GitFile, type GitStatus, gitErrorText, useGitAction, useGitSync } from "./queries.ts";
import { Header, SyncNote } from "./sync-note.tsx";

// The source-control column of a checkout: branch and sync, the changed files as a tree per
// group with their actions, and the commit box. The git tile shows it beside the diff; what a
// click on a file does is the tile's.
export function SourceControl({
  location,
  s,
  pick,
  onPick,
}: {
  location: string;
  s: GitStatus;
  pick: Pick | null;
  onPick: (p: Pick) => void;
}) {
  const gitSync = useGitSync(location);
  const act = useGitAction(location);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [discarding, setDiscarding] = useState<(GitFile & { version?: string })[] | null>(null);
  const g = groups(s);
  const notes = noteCounts(useNotes(location));
  const onToggle = (key: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const shared = {
    notes,
    pick,
    onPick,
    closed,
    onToggle,
    act,
    onDiscard: (files: GitFile[]) =>
      setDiscarding(files.map((f) => ({ ...f, version: s.versions?.[f.path] }))),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header s={s} write={gitSync} />
      <SyncNote op={gitSync.variables} result={gitSync.data} error={gitSync.error} />
      {act.error && (
        <InlineError className="border-b border-line px-3 py-2 text-[12px]">
          {gitErrorText(act.error)}
        </InlineError>
      )}
      {s.truncated && (
        <p className="border-b border-line px-3 py-2 text-[12px] text-warn">
          Hay más cambios de los que se listan: se muestran los primeros {s.files.length}; «todo»
          actúa solo sobre ellos.
        </p>
      )}
      <nav aria-label="Ficheros cambiados" className="min-h-0 flex-1 overflow-y-auto py-1">
        {s.files.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-ink-2">
            Sin cambios: el árbol de trabajo está limpio.
          </p>
        ) : (
          <>
            <Group title="En conflicto" side="conflict" files={g.conflicts} {...shared} />
            <Group title="Preparados" side="staged" files={g.staged} {...shared} />
            <Group title="Cambios" side="unstaged" files={g.unstaged} {...shared} />
            <Group title="Sin seguimiento" side="untracked" files={g.untracked} {...shared} />
          </>
        )}
      </nav>
      <CommitBox location={location} stagedCount={g.staged.length} conflicts={g.conflicts.length} />
      {discarding && (
        <Modal title="Descartar cambios" onClose={() => setDiscarding(null)}>
          <div className="space-y-3 p-4 text-[13px]">
            <p>
              Se pierden los cambios sin preparar de{" "}
              {plural(discarding.length, "fichero", "ficheros")}; lo preparado se queda. Se conserva
              una copia recuperable.
            </p>
            <ul className="max-h-48 overflow-y-auto rounded-md border border-line p-2 font-mono text-[12px]">
              {discarding.map((f) => (
                <li key={f.path} className="truncate">
                  {f.path}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setDiscarding(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={act.isPending || discarding.some((f) => !f.version)}
                onClick={() =>
                  act.mutate(
                    {
                      op: "discard",
                      paths: discarding.map((f) => f.path),
                      versions: Object.fromEntries(
                        discarding.map((f) => [f.path, f.version ?? ""]),
                      ),
                    },
                    { onSettled: () => setDiscarding(null) },
                  )
                }
              >
                Descartar
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
