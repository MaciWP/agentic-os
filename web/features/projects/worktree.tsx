import { type FormEvent, useId, useState } from "react";
import { ApiError } from "../../api.ts";
import { InlineError } from "../../ui.tsx";
import { gitErrorText } from "../git/queries.ts";
import { NodeLink, useShowNode } from "../terminals/node-link.tsx";
import { type AddResult, useAddWorktree, useBranches, useRemoveWorktree } from "./queries.ts";

const HEADS = "refs/heads/";
const ORIGIN = "refs/remotes/origin/";
// A failed write shows from the mutation's own error.
const noop = () => {};

// "main" for refs/heads/main, "origin/main" for refs/remotes/origin/main.
const shortRef = (ref: string) =>
  ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref.replace(/^refs\/remotes\//, "");

// The names a new worktree can take as they are: local branches and origin's, once each.
function branchNames(local: string[], remote: string[]) {
  const names = [
    ...local.map((r) => r.slice(HEADS.length)),
    ...remote.filter((r) => r.startsWith(ORIGIN)).map((r) => r.slice(ORIGIN.length)),
  ];
  return [...new Set(names)];
}

// "Nuevo worktree" on a repo node: a branch, and the base a new one starts from. An existing
// branch, local or origin's, opens as it is. The server fetches first and refuses in words.
export function NewWorktreeForm({ repo, onDone }: { repo: string; onDone: () => void }) {
  const branches = useBranches(repo);
  const add = useAddWorktree();
  const showNode = useShowNode();
  const list = useId();
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState<string | null>(null);
  const [done, setDone] = useState<AddResult | null>(null);
  const data = branches.data;
  const picked = base ?? data?.base ?? "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = branch.trim();
    if (!name || add.isPending) return;
    // The awaited promise, not mutate's callbacks: the push that follows a write can
    // re-render the pane first, and a callback whose component is gone never runs.
    add.mutateAsync({ repo, branch: name, ...(picked && { base: picked }) }).then((r) => {
      // Without the fetch it started from what the clone had: say so before leaving.
      if (r.fetchError) return setDone(r);
      onDone();
      showNode(r.location);
    }, noop);
  };

  if (done)
    return (
      <p role="status" className="basis-full text-[12px] text-warn">
        Worktree creado en <span className="font-mono">{done.path}</span> sin consultar el remoto (
        {done.fetchError}).{" "}
        <NodeLink node={done.location} className="text-primary underline" onClick={onDone}>
          Abrir
        </NodeLink>
      </p>
    );

  return (
    <form
      onSubmit={submit}
      aria-label={`Nuevo worktree de ${repo}`}
      className="basis-full space-y-2 pt-1"
    >
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Rama"
          className="btn min-w-0 flex-1 basis-48 font-mono"
          placeholder="Rama, nueva o existente"
          list={list}
          value={branch}
          maxLength={200}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setBranch(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: the form opens on an explicit click
          autoFocus
        />
        <datalist id={list}>
          {data && branchNames(data.local, data.remote).map((n) => <option key={n} value={n} />)}
        </datalist>
        <select
          aria-label="Base"
          className="btn min-w-0 max-w-full font-mono"
          value={picked}
          disabled={!data}
          onChange={(e) => setBase(e.target.value)}
        >
          {!data ? (
            <option value="">{branches.isError ? "Sin ramas" : "Cargando ramas…"}</option>
          ) : (
            <>
              {!data.base && <option value="">Base por defecto del remoto</option>}
              {[...data.remote, ...data.local].map((r) => (
                <option key={r} value={r}>
                  {shortRef(r)}
                </option>
              ))}
            </>
          )}
        </select>
      </div>
      <p className="text-[12px] text-ink-2">
        Una rama que ya existe se abre tal cual; la base solo cuenta para una rama nueva.
      </p>
      {branches.isError && (
        <InlineError className="text-[12px]">
          No se han podido leer las ramas: {gitErrorText(branches.error)}
        </InlineError>
      )}
      {add.error && (
        <InlineError className="text-[12px]">
          No se ha creado: {gitErrorText(add.error)}
        </InlineError>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={add.isPending || !branch.trim()}
        >
          {add.isPending ? "Creando…" : "Crear worktree"}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

// "Quitar" on a worktree the app made: `git worktree remove`, never forced. The folder goes,
// the branch stays. Ignored files would go with it silently, so the server stops first and
// the user decides.
function RemoveWorktreeConfirm({
  location,
  repoLocation,
  onDone,
}: {
  location: string;
  repoLocation: string;
  onDone: () => void;
}) {
  const remove = useRemoveWorktree();
  const showNode = useShowNode();
  const err = remove.error;
  const ignored = err instanceof ApiError && err.reason === "ignored";
  const run = (dropIgnored: boolean) =>
    // Awaited: the removed node leaves the tree with the next read, and the pane with it.
    remove.mutateAsync({ location, ...(dropIgnored && { dropIgnored }) }).then(() => {
      onDone();
      showNode(repoLocation);
    }, noop);
  return (
    <div className="basis-full space-y-2 pt-1 text-[12px]">
      <p>Se borra la carpeta del worktree; la rama y sus commits se quedan.</p>
      {err && <InlineError>No se ha quitado: {gitErrorText(err)}</InlineError>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={remove.isPending}
          onClick={() => run(ignored)}
        >
          {remove.isPending ? "Quitando…" : ignored ? "Quitar igualmente" : "Quitar"}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// The worktree actions in the pane's header: "Nuevo worktree" on a repo node, "Quitar" on a
// worktree the app made. Without a usable worktrees.root the reason shows instead.
export function WorktreeActions({
  kind,
  repo,
  node,
  removable,
  setup,
  pushRight,
}: {
  kind: "repo" | "worktree";
  repo: string;
  node: string;
  removable: boolean;
  setup: { error: string | null };
  pushRight: boolean;
}) {
  const [open, setOpen] = useState(false);
  const place = pushRight ? "ml-auto" : "";
  if (kind === "worktree" && !removable) return null;
  if (kind === "repo" && setup.error)
    return (
      <span className={`text-[12px] text-ink-2 ${place}`}>
        Nuevo worktree no disponible. {setup.error}
      </span>
    );
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        className={`btn-ghost ${place}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {kind === "repo" ? "Nuevo worktree" : "Quitar worktree"}
      </button>
      {open &&
        (kind === "repo" ? (
          <NewWorktreeForm repo={repo} onDone={close} />
        ) : (
          <RemoveWorktreeConfirm location={node} repoLocation={`repo:${repo}`} onDone={close} />
        ))}
    </>
  );
}
