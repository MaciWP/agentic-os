import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { errorDetail } from "../../api.ts";
import { Icon } from "../../icons.tsx";
import { shortcut } from "../../keys.ts";
import { useActiveOption } from "../../listbox.ts";
import { InlineError } from "../../ui.tsx";
import { display, expandHome, fieldText, filterEntries, splitInput } from "./paths.ts";
import { type FolderEntry, type Listing, useFolders, usePlaces } from "./queries.ts";

// Choosing a folder of the host inside the app: places to jump to, a path field that filters
// the current folder as you type, and its subfolders one level at a time. It knows nothing
// of what the folder is for: `check` says why the shown folder cannot be picked and `mark`
// tags a row. Content only; the caller puts it in a `Modal`, which brings Esc and the focus.

export type FolderPickerProps = {
  // The first folder shown; by default the first place (the repos' folder, else home).
  start?: string;
  // null: the shown folder can be picked; text: why not.
  check?: (listing: Listing) => string | null;
  mark?: (entry: FolderEntry) => ReactNode;
  // The pick button's text.
  action: string;
  busy?: boolean;
  // The caller's own failure with the folder picked.
  error?: Error | null;
  onPick: (path: string) => void;
  onCancel: () => void;
};

export function FolderPicker({
  start,
  check,
  mark,
  action,
  busy = false,
  error = null,
  onPick,
  onCancel,
}: FolderPickerProps) {
  const places = usePlaces();
  const home = places.data?.home ?? null;
  const [want, setWant] = useState<string | null>(start ?? null);
  const target = want ?? places.data?.places[0]?.path ?? home;
  const folders = useFolders(target);

  // The last folder read stays on screen while the next one loads, and when it fails.
  const [shown, setShown] = useState<Listing | null>(null);
  if (folders.data && folders.data !== shown) setShown(folders.data);
  // The field follows the folder shown; typing changes it until the next folder is read.
  const [text, setText] = useState("");
  const [textFor, setTextFor] = useState<string | null>(null);
  const fieldFor = shown ? `${shown.path}\n${home}` : null;
  if (shown && fieldFor !== textFor) {
    setTextFor(fieldFor);
    setText(fieldText(shown.path, home));
  }

  const typed = expandHome(text, home);
  const { dir, tail } = splitInput(typed);
  const rows = shown && dir === shown.path ? filterEntries(shown.entries, tail) : [];
  const listId = useId();
  const { at, activeId, optionId, setActive, onKeyDown } = useActiveOption(
    rows.length,
    `${listId}-opt`,
  );

  // Every move, by key, place, row or "up", leaves the keys in the field to type on.
  const field = useRef<HTMLInputElement>(null);
  const go = (path: string) => {
    setWant(path);
    setActive(0);
    field.current?.focus();
  };
  const reason = shown && check ? check(shown) : null;
  // Not while the folder asked for has no answer yet: the one on screen is the previous one.
  const canPick = shown !== null && !reason && !busy && !folders.isPending;
  const elsewhere = typed.replace(/(.)\/+$/, "$1");
  const goHint = shown && rows.length === 0 && text && elsewhere !== shown.path;

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canPick) onPick(shown.path);
      return;
    }
    if (onKeyDown(e, (i) => go(rows[i]?.path ?? typed))) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (elsewhere) go(elsewhere);
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      {(places.data?.places.length ?? 0) > 0 && (
        <fieldset aria-label="Lugares" className="flex flex-wrap gap-1.5 px-3 pt-3">
          {places.data?.places.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pill cursor-pointer gap-1 hover:bg-accent aria-[current=true]:bg-[var(--selected)] aria-[current=true]:text-ink"
              aria-current={shown?.path === p.path || undefined}
              title={display(p.path, home)}
              onClick={() => go(p.path)}
            >
              <Icon name={p.id === "home" ? "home" : "folder"} size={12} />
              {p.label}
            </button>
          ))}
        </fieldset>
      )}
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <button
          type="button"
          className="btn-ghost"
          aria-label="Subir a la carpeta de arriba"
          title="Subir a la carpeta de arriba"
          disabled={!shown?.parent}
          onClick={() => shown?.parent && go(shown.parent)}
        >
          <Icon name="up" size={14} />
        </button>
        <input
          ref={field}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label="Ruta de la carpeta"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          // The picker opens to be typed in (Modal focuses it).
          data-autofocus
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-transparent px-2 font-mono text-[12px]"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={keys}
        />
        {folders.isFetching && (
          <span
            role="status"
            aria-label="Leyendo la carpeta"
            className="grid text-ink-2 motion-safe:animate-spin"
          >
            <Icon name="refresh" size={13} />
          </span>
        )}
      </div>
      <div className="flex h-[min(320px,45vh)] flex-col">
        <ListNote
          error={folders.error}
          empty={shown !== null && shown.entries.length === 0}
          unmatched={shown !== null && rows.length === 0 && shown.entries.length > 0}
          go={goHint ? display(elsewhere, home) : null}
          truncated={shown?.truncated ?? false}
        />
        <div id={listId} role="listbox" aria-label="Carpetas" className="option-list">
          {rows.map((e, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys reach the row through the combobox.
            <div
              key={e.path}
              id={optionId(i)}
              role="option"
              tabIndex={-1}
              aria-selected={i === at}
              className="option"
              onMouseMove={() => setActive(i)}
              onClick={() => go(e.path)}
            >
              <span className="grid w-4 shrink-0 place-items-center text-ink-2">
                <Icon name="folder" size={14} />
              </span>
              <span className="truncate">{e.name}</span>
              {mark && <span className="ml-auto flex shrink-0 gap-1">{mark(e)}</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        <p role="status" className="min-w-0 flex-1 text-[12px]">
          <span className="block truncate font-mono" title={shown?.path}>
            {shown ? display(shown.path, home) : "…"}
          </span>
          {reason && <span className="block text-ink-2">{reason}</span>}
        </p>
        <button type="button" className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canPick}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          title={shortcut("Enter")}
          onClick={() => shown && onPick(shown.path)}
        >
          {busy ? "Un momento…" : action}
        </button>
        {error && (
          <InlineError className="w-full break-words text-[12px]">{errorDetail(error)}</InlineError>
        )}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-2">
        ↑↓ moverse · Enter abrir · {shortcut("Enter")} elegir esta carpeta · Esc cerrar
      </p>
    </div>
  );
}

// What the list says when it shows no folders, or that it shows only some.
function ListNote({
  error,
  empty,
  unmatched,
  go,
  truncated,
}: {
  error: Error | null;
  empty: boolean;
  unmatched: boolean;
  go: string | null;
  truncated: boolean;
}) {
  const note = (text: string) => (
    <p className="shrink-0 px-4 pt-2 text-[12px] text-ink-2">{text}</p>
  );
  if (error)
    return (
      <InlineError className="shrink-0 break-words px-4 pt-2 text-[12px]">
        {errorDetail(error)}
      </InlineError>
    );
  return (
    <>
      {go && note(`Enter: ir a ${go}`)}
      {!go && empty && note("Sin subcarpetas.")}
      {!go && unmatched && note("Ninguna carpeta empieza así.")}
      {truncated && note("Hay más de 2000 carpetas: escribe la ruta.")}
    </>
  );
}
