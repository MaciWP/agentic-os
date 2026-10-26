import { useQueries } from "@tanstack/react-query";
import { type KeyboardEvent, useState } from "react";
import { Icon } from "../../icons.tsx";
import { errorText, InlineError, SkeletonRows } from "../../ui.tsx";
import { ancestors } from "./nav.ts";
import { codeTreeQuery, useCodeTree } from "./queries.ts";

type Props = {
  location: string;
  open: Set<string>;
  selected: string | null;
  onToggle: (dir: string) => void;
  onPick: (path: string) => void;
};
// The row Tab lands on: the last one focused, or the first row when that one is out of sight.
type Roving = { tabStop: string | null; onFocusRow: (path: string) => void };

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 12 });

// One folder's entries and, under each open folder, its own; a folder is read the first time
// it opens. What git ignores stays in sight, greyed, as an editor shows it.
function Folder({ dir, depth, ...p }: Props & Roving & { dir: string; depth: number }) {
  const listing = useCodeTree(p.location, dir);
  if (listing.isPending) {
    return (
      <div style={indent(depth)}>
        <SkeletonRows count={1} />
      </div>
    );
  }
  if (listing.isError) {
    return (
      <div style={indent(depth)}>
        <InlineError className="py-1 pr-2 text-[12px]">
          {errorText(listing.error)}{" "}
          <button type="button" className="underline" onClick={() => listing.refetch()}>
            Reintentar
          </button>
        </InlineError>
      </div>
    );
  }
  const { entries, truncated } = listing.data;
  return (
    <>
      {entries.map((e, i) => {
        const folder = e.kind === "folder";
        const opened = folder && p.open.has(e.path);
        const stop = p.tabStop === null ? depth === 0 && i === 0 : p.tabStop === e.path;
        return (
          <div key={e.path} role="none">
            <button
              type="button"
              role="treeitem"
              tabIndex={stop ? 0 : -1}
              data-code-row={e.kind}
              data-path={e.path}
              aria-level={depth + 1}
              aria-setsize={entries.length}
              aria-posinset={i + 1}
              aria-expanded={folder ? opened : undefined}
              aria-selected={!folder ? p.selected === e.path : undefined}
              title={e.ignored ? `${e.path} (ignorado por git)` : e.path}
              className={`flex h-6 w-full items-center gap-1 truncate pr-2 text-left font-mono text-[12px] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none aria-selected:bg-[var(--selected)] ${
                e.ignored ? "text-ink-2/60" : "text-ink"
              }`}
              style={indent(depth)}
              onFocus={() => p.onFocusRow(e.path)}
              onClick={() => (folder ? p.onToggle(e.path) : p.onPick(e.path))}
            >
              <span
                className={`inline-flex w-3 shrink-0 text-ink-2 transition-transform ${
                  opened ? "rotate-90" : ""
                } ${folder ? "" : "invisible"}`}
              >
                <Icon name="chevron" size={12} />
              </span>
              <span className="truncate">{e.name}</span>
            </button>
            {opened && <Folder {...p} dir={e.path} depth={depth + 1} />}
          </div>
        );
      })}
      {entries.length === 0 && (
        <p className="py-1 text-[12px] text-ink-2" style={indent(depth + 1)}>
          Vacía
        </p>
      )}
      {truncated && (
        <p className="py-1 text-[12px] text-warn" style={indent(depth + 1)}>
          Solo se muestran las primeras 2000 entradas.
        </p>
      )}
    </>
  );
}

// The WAI-ARIA tree keys: j/k or the arrows move between rows, Home/End to the ends; l/→
// opens a folder and then enters it, h/← closes it and then goes up to its folder. Enter and
// Space are the button's own.
function onKeys(e: KeyboardEvent<HTMLElement>, p: Props) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-code-row]")];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const row = rows[at];
  const path = row?.dataset.path ?? "";
  const open = row?.dataset.codeRow === "folder" && p.open.has(path);
  const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
  if (step) rows[Math.max(0, Math.min(rows.length - 1, at + step))]?.focus();
  else if (e.key === "Home") rows[0]?.focus();
  else if (e.key === "End") rows.at(-1)?.focus();
  else if (row && (e.key === "l" || e.key === "ArrowRight")) {
    if (row.dataset.codeRow !== "folder") return;
    if (open) rows[at + 1]?.focus();
    else p.onToggle(path);
  } else if (row && (e.key === "h" || e.key === "ArrowLeft")) {
    if (open) p.onToggle(path);
    else rows.find((r) => r.dataset.path === path.slice(0, path.lastIndexOf("/")))?.focus();
  } else return;
  e.preventDefault();
}

export function CodeTree(p: Props) {
  const [focused, setFocused] = useState<string | null>(null);
  const last = focused ?? p.selected;
  // The row is drawn only when every folder above it is open and lists it: not while one
  // loads, nor once the file is gone or past a folder's cap. Otherwise the first row takes
  // Tab, so the tree is never out of the keyboard's reach. The listings are the folders' own
  // (same keys), and a closed one is not asked for.
  const dirs = ["", ...ancestors(last ?? "")];
  const listings = useQueries({
    queries: dirs.map((dir) => ({
      ...codeTreeQuery(p.location, dir),
      enabled: dir === "" || p.open.has(dir),
    })),
  });
  const shown =
    last !== null &&
    dirs.every(
      (dir, i) =>
        (dir === "" || p.open.has(dir)) &&
        listings[i]?.data?.entries.some((e) => e.path === (dirs[i + 1] ?? last)),
    );
  return (
    <div
      role="tree"
      aria-label="Ficheros"
      className="h-full overflow-auto py-1"
      onKeyDown={(e) => onKeys(e, p)}
    >
      <Folder {...p} tabStop={shown ? last : null} onFocusRow={setFocused} dir="" depth={0} />
    </div>
  );
}
