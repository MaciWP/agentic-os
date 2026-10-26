import { Icon } from "../../icons.tsx";
import { CODE, type Pick, type Side, TONE } from "./changes.ts";
import type { GitFile, useGitAction } from "./queries.ts";
import { buildTree, filesUnder, type TreeNode } from "./tree.ts";

type Act = ReturnType<typeof useGitAction>;

const ROW_ICON =
  "inline-grid size-5 shrink-0 place-items-center rounded text-ink-2 hover:bg-[var(--selected)] hover:text-ink disabled:opacity-40";

// The actions a row of one side offers on its files: stage, unstage, discard, resolve.
function RowActions({
  side,
  files,
  label,
  act,
  onDiscard,
}: {
  side: Side;
  files: GitFile[];
  label: string;
  act: Act;
  onDiscard: (files: GitFile[]) => void;
}) {
  const paths = files.map((f) => f.path);
  const tracked = files.filter((f) => f.kind !== "untracked");
  const busy = act.isPending;
  const one = files.length === 1 ? files[0] : undefined;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
      {side === "unstaged" && tracked.length > 0 && (
        <button
          type="button"
          className={ROW_ICON}
          disabled={busy}
          aria-label={`Descartar cambios de ${label}`}
          title="Descartar los cambios sin preparar; lo preparado se queda"
          onClick={() => onDiscard(tracked)}
        >
          <Icon name="undo" size={13} />
        </button>
      )}
      {(side === "unstaged" || side === "untracked") && (
        <button
          type="button"
          className={ROW_ICON}
          disabled={busy}
          aria-label={`Preparar ${label}`}
          title="Preparar para el commit"
          onClick={() => act.mutate({ op: "stage", paths })}
        >
          <Icon name="plus" size={13} />
        </button>
      )}
      {side === "staged" && (
        <button
          type="button"
          className={ROW_ICON}
          disabled={busy}
          aria-label={`Quitar ${label} de lo preparado`}
          title="Quitar de lo preparado"
          onClick={() => act.mutate({ op: "unstage", paths })}
        >
          <Icon name="minus" size={13} />
        </button>
      )}
      {side === "conflict" && one && (
        <button
          type="button"
          className={ROW_ICON}
          disabled={busy}
          aria-label={`Marcar ${label} como resuelto`}
          title="Marcar como resuelto: se prepara tal como está, sin marcas de conflicto"
          onClick={() => act.mutate({ op: "resolve", path: one.path })}
        >
          <Icon name="check" size={13} />
        </button>
      )}
    </span>
  );
}

function Rows({
  nodes,
  depth,
  side,
  notes,
  pick,
  onPick,
  closed,
  onToggle,
  act,
  onDiscard,
}: {
  nodes: TreeNode[];
  depth: number;
  side: Side;
  notes: ReadonlyMap<string, number>;
  pick: Pick | null;
  onPick: (p: Pick) => void;
  closed: Set<string>;
  onToggle: (key: string) => void;
  act: Act;
  onDiscard: (files: GitFile[]) => void;
}) {
  const pad = { paddingLeft: `${8 + depth * 12}px` };
  return nodes.map((node) => {
    if (node.kind === "dir") {
      const key = `${side}:${node.path}`;
      const open = !closed.has(key);
      return (
        <li key={key}>
          <div className="group/row flex h-6 items-center gap-1 rounded pr-1 hover:bg-[var(--hover)]">
            <button
              type="button"
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-1 text-left text-[12px] text-ink-2"
              style={pad}
              onClick={() => onToggle(key)}
            >
              <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
                <Icon name="chevron" size={12} />
              </span>
              <span className="truncate font-mono">{node.name}</span>
            </button>
            <RowActions
              side={side}
              files={filesUnder(node)}
              label={`la carpeta ${node.path}`}
              act={act}
              onDiscard={onDiscard}
            />
          </div>
          {open && (
            <ul>
              <Rows
                nodes={node.children}
                depth={depth + 1}
                side={side}
                notes={notes}
                pick={pick}
                onPick={onPick}
                closed={closed}
                onToggle={onToggle}
                act={act}
                onDiscard={onDiscard}
              />
            </ul>
          )}
        </li>
      );
    }
    const f = node.file;
    const staged = side === "staged";
    const code = staged ? f.x : f.y;
    const word = CODE[code] ?? code;
    const current = pick?.path === f.path && pick.staged === staged;
    const noted = notes.get(`${staged ? "s" : "w"}:${f.path}`) ?? 0;
    return (
      <li key={`${side}:${f.path}`}>
        <div
          className={`group/row flex h-6 items-center gap-1 rounded pr-1 ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
        >
          <button
            type="button"
            aria-pressed={current}
            aria-label={`${f.path}, ${word}${noted ? `, ${noted === 1 ? "1 nota" : `${noted} notas`} sin enviar` : ""}`}
            title={f.orig ? `${f.orig} → ${f.path}` : f.path}
            data-pick={`${staged ? "s" : "w"}:${f.path}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]"
            style={{ paddingLeft: `${20 + depth * 12}px` }}
            onClick={() => onPick({ path: f.path, staged })}
          >
            <span className="truncate font-mono">{node.name}</span>
            {f.orig && <span className="truncate text-ink-2">← {f.orig}</span>}
            {noted > 0 && (
              <span
                className="ml-auto inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-warn px-1 font-semibold text-[10px] text-[var(--on-accent)] tabular-nums"
                title={noted === 1 ? "1 nota sin enviar" : `${noted} notas sin enviar`}
              >
                {noted}
              </span>
            )}
          </button>
          <RowActions side={side} files={[f]} label={f.path} act={act} onDiscard={onDiscard} />
          <span
            aria-hidden
            className={`w-3 shrink-0 text-center font-mono text-[11px] ${TONE[code] ?? "text-ink-2"}`}
          >
            {code === "?" ? "N" : code}
          </span>
        </div>
      </li>
    );
  });
}

export function Group({
  title,
  side,
  files,
  ...rest
}: {
  title: string;
  side: Side;
  files: GitFile[];
  notes: ReadonlyMap<string, number>;
  pick: Pick | null;
  onPick: (p: Pick) => void;
  closed: Set<string>;
  onToggle: (key: string) => void;
  act: Act;
  onDiscard: (files: GitFile[]) => void;
}) {
  if (files.length === 0) return null;
  const key = `group:${side}`;
  const open = !rest.closed.has(key);
  return (
    <section aria-label={title} className="pb-1">
      <div className="group/row flex h-7 items-center gap-1 px-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 px-1 text-left text-[11px] font-medium text-ink-2 uppercase tracking-wide"
          onClick={() => rest.onToggle(key)}
        >
          <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
            <Icon name="chevron" size={12} />
          </span>
          {title}
          <span className="pill ml-1 h-4 px-1.5 tabular-nums">{files.length}</span>
        </button>
        <RowActions
          side={side}
          files={files}
          label={`todo en ${title}`}
          act={rest.act}
          onDiscard={rest.onDiscard}
        />
      </div>
      {open && (
        <ul className="px-1">
          <Rows nodes={buildTree(files)} depth={0} side={side} {...rest} />
        </ul>
      )}
    </section>
  );
}
