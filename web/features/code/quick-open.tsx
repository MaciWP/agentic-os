import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, InlineError } from "../../ui.tsx";
import { rankFiles } from "./nav.ts";
import { useCodeFiles } from "./queries.ts";

// ⌘P inside a code tile: a search box over the checkout's files, as git sees them, laid over
// the top of the tile (never a window of its own). Its own ranking, not cmdk's: a big repo
// has tens of thousands of paths and only the best 50 are drawn.
export function QuickOpen({
  location,
  onPick,
  onClose,
}: {
  location: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const files = useCodeFiles(location, true);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => rankFiles(files.data?.files ?? [], query), [files.data, query]);
  useEffect(() => input.current?.focus(), []);
  const pick = (path: string | undefined) => {
    if (path) onPick(path);
  };

  return (
    <div className="absolute inset-x-2 top-2 z-20 mx-auto max-w-[36rem] overflow-hidden rounded-md border border-line bg-panel shadow-2">
      <input
        ref={input}
        aria-label="Abrir fichero"
        role="combobox"
        aria-expanded
        aria-controls={`quick-open-${location}`}
        aria-activedescendant={shown[at] ? `quick-open-${location}-${at}` : undefined}
        placeholder="Nombre del fichero…"
        className="h-9 w-full border-line border-b bg-transparent px-3 font-mono text-[12px] text-ink outline-none"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter") pick(shown[at]);
          else if (e.key === "ArrowDown") setAt(Math.min(shown.length - 1, at + 1));
          else if (e.key === "ArrowUp") setAt(Math.max(0, at - 1));
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {files.isError ? (
        <InlineError className="px-3 py-2 text-[12px]">{errorText(files.error)}</InlineError>
      ) : files.isPending ? (
        <p className="px-3 py-2 text-[12px] text-ink-2">Leyendo los ficheros…</p>
      ) : !files.data.git ? (
        <p className="px-3 py-2 text-[12px] text-ink-2">
          Aquí no hay ningún repo de git: navega por el árbol.
        </p>
      ) : (
        <div id={`quick-open-${location}`} role="listbox" className="max-h-80 overflow-auto py-1">
          {shown.map((f, i) => {
            const slash = f.lastIndexOf("/");
            return (
              <div
                key={f}
                id={`quick-open-${location}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === at}
                className="flex cursor-pointer items-baseline gap-2 truncate px-3 py-1 font-mono text-[12px] aria-selected:bg-[var(--selected)]"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(f);
                }}
                onMouseEnter={() => setAt(i)}
              >
                <span className="text-ink">{f.slice(slash + 1)}</span>
                <span className="truncate text-ink-2">{f.slice(0, slash + 1)}</span>
              </div>
            );
          })}
          {shown.length === 0 && <p className="px-3 py-1 text-[12px] text-ink-2">Nada</p>}
          {files.data.truncated && (
            <p className="px-3 py-1 text-[12px] text-warn">Lista recortada a 50 000 ficheros.</p>
          )}
        </div>
      )}
    </div>
  );
}
