import { Fragment, useMemo } from "react";
import { z } from "zod";
import { Icon } from "../../icons.tsx";
import { storageKey } from "../../storage.ts";
import { ErrorState, InlineError, SkeletonRows, StaleNotice } from "../../ui.tsx";
import { openIn } from "../code/open.ts";
import { codeTile } from "../terminals/grid-state.ts";
import { useOpenTile } from "../terminals/node-link.tsx";
import type { Pick } from "./changes.ts";
import { type DiffLine, diffStats, parseDiff, type Segment, splitRows } from "./diff.ts";
import { type NotesLayer, useDiffNotes } from "./diff-notes.tsx";
import { type GitFile, gitErrorText, useGitAction, useGitDiff } from "./queries.ts";

export type DiffMode = "unified" | "split";

// The last view the user picked, per browser; a blocked storage falls back to unified.
const modeKey = storageKey("aos.git.diff", {
  schema: z.enum(["unified", "split"]),
  fallback: "unified",
});
export const storedMode = (): DiffMode => modeKey.get();

// Removed lines red, added green; inside a changed pair the words that differ are stronger.
const TINT = {
  add: { line: "bg-ok/10", word: "bg-ok/35 rounded-[2px]", mark: "text-ok" },
  del: { line: "bg-bad/10", word: "bg-bad/35 rounded-[2px]", mark: "text-bad" },
  context: { line: "", word: "", mark: "text-ink-2" },
} as const;

const GUTTER = "select-none px-2 text-right text-ink-2/70 tabular-nums";
const PICKED = "bg-warn/15";

// A line number: a click opens a note on its line, Shift+click stretches it to a range.
// ponytail: mouse only (no tab stop per line); add a keyboard way in when one is asked for.
function Num({
  n,
  i,
  notes,
  tint,
}: {
  n: number | null;
  i: number;
  notes: NotesLayer;
  tint: string;
}) {
  const bg = notes.picked(i) ? PICKED : tint;
  if (n === null) return <span className={`${GUTTER} ${bg}`} />;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Nota en la línea ${n}`}
      title="Nota en esta línea · Mayús+clic: rango"
      className={`${GUTTER} ${bg} cursor-pointer hover:bg-warn/20 hover:text-warn ${notes.noted(i) ? "shadow-[inset_2px_0_0_var(--warn)]" : ""}`}
      onClick={(e) => notes.onLine(i, e.shiftKey)}
    >
      {n}
    </button>
  );
}

function Words({ line }: { line: DiffLine }) {
  const body = line.text.slice(1);
  if (!line.words || line.kind === "context") return <>{body || " "}</>;
  const tint = TINT[line.kind as "add" | "del"].word;
  return (
    <>
      {line.words.map((w: Segment, i) => (
        // The segments are a fixed list: a segment's index is its identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <span key={i} className={w.changed ? tint : undefined}>
          {w.text}
        </span>
      ))}
    </>
  );
}

type HunkBar = { canAct: boolean; staged: boolean; busy: boolean; onHunk: (index: number) => void };

function HunkRow({ line, bar, span }: { line: DiffLine; bar: HunkBar; span: string }) {
  return (
    <div data-hunk={line.hunk} className={`${span} border-y border-line/60 bg-[var(--hover)]`}>
      {/* Long lines widen the grid past the tile: the bar stays in view, as wide as it. */}
      <div className="sticky left-0 flex w-[100cqw] items-center gap-2 px-2 py-0.5 text-primary">
        <span className="min-w-0 flex-1 truncate">{line.text}</span>
        {bar.canAct && line.hunk !== null && (
          <button
            type="button"
            className="btn-ghost h-5 shrink-0 gap-1 font-sans text-[11px]"
            disabled={bar.busy}
            onClick={() => bar.onHunk(line.hunk as number)}
          >
            <Icon name={bar.staged ? "minus" : "plus"} size={12} />
            {bar.staged ? "Quitar hunk" : "Preparar hunk"}
          </button>
        )}
      </div>
    </div>
  );
}

function Unified({ lines, bar, notes }: { lines: DiffLine[]; bar: HunkBar; notes: NotesLayer }) {
  return (
    <div className="grid min-w-max grid-cols-[auto_auto_auto_1fr] font-mono text-[12px] leading-5">
      {lines.map((l, i) => {
        // The diff is a fixed list: a line's index is its identity.
        if (l.kind === "hunk")
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          return <HunkRow key={i} line={l} bar={bar} span="col-span-4" />;
        if (l.kind === "meta")
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <div key={i} className="col-span-4 whitespace-pre px-2 text-ink-2">
              {l.text}
            </div>
          );
        const tint = TINT[l.kind];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Fragment key={i}>
            <div className={`contents`} data-line={l.kind}>
              <Num n={l.old} i={i} notes={notes} tint={tint.line} />
              <Num n={l.new} i={i} notes={notes} tint={tint.line} />
              <span aria-hidden className={`select-none px-1 ${tint.line} ${tint.mark}`}>
                {l.text[0] === " " ? "" : l.text[0]}
              </span>
              <span className={`whitespace-pre pr-4 ${tint.line}`}>
                <Words line={l} />
              </span>
            </div>
            {notes.after(i)}
          </Fragment>
        );
      })}
    </div>
  );
}

function Split({ lines, bar, notes }: { lines: DiffLine[]; bar: HunkBar; notes: NotesLayer }) {
  // Notes speak of a line's index in the diff; a row holds the line itself.
  const index = useMemo(() => new Map(lines.map((l, i) => [l, i])), [lines]);
  const cell = (l: DiffLine | null, side: "old" | "new") => {
    const tint = l ? TINT[l.kind as "add" | "del" | "context"] : null;
    const bg = tint?.line ?? "bg-[var(--hover)]/40";
    const i = l ? index.get(l) : undefined;
    return (
      <>
        {i === undefined ? (
          <span className={`${GUTTER} ${bg}`} />
        ) : (
          <Num n={l?.[side] ?? null} i={i} notes={notes} tint={bg} />
        )}
        <span className={`min-w-0 whitespace-pre-wrap break-all pr-2 ${bg}`}>
          {l && <Words line={l} />}
        </span>
      </>
    );
  };
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] font-mono text-[12px] leading-5">
      {splitRows(lines).map((r, i) => {
        if (r.kind === "full") {
          return r.line.kind === "hunk" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row's index is its identity
            <HunkRow key={i} line={r.line} bar={bar} span="col-span-4" />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row's index is its identity
            <div key={i} className="col-span-4 whitespace-pre-wrap break-all px-2 text-ink-2">
              {r.line.text}
            </div>
          );
        }
        const left = r.left ? index.get(r.left) : undefined;
        const right = r.right ? index.get(r.right) : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row's index is its identity
          <Fragment key={i}>
            <div className="contents">
              {cell(r.left, "old")}
              {cell(r.right, "new")}
            </div>
            {left !== undefined && notes.after(left)}
            {right !== undefined && right !== left && notes.after(right)}
          </Fragment>
        );
      })}
    </div>
  );
}

// One file's diff: where it is, how much it adds and removes, each side's line numbers and
// the words that changed, unified or side by side. Hunks are staged or taken back here when
// the server says the file allows it. The window reads it again while visible (`poll`).
// ponytail: no syntax highlighting; add it when plain colour stops being enough.
export function DiffView({
  location,
  pick,
  file,
  mode,
  onMode,
  poll = false,
}: {
  location: string;
  pick: Pick;
  file: GitFile | undefined;
  mode: DiffMode;
  onMode: (mode: DiffMode) => void;
  poll?: boolean;
}) {
  const diff = useGitDiff(location, pick.path, pick.staged, poll);
  const act = useGitAction(location);
  const openTile = useOpenTile();
  // Parsed once per diff text: a poll that brings the same text, a hunk action or a switch
  // between unified and split reuses it.
  const text = diff.data?.diff;
  const lines = useMemo(() => (text === undefined ? [] : parseDiff(text)), [text]);
  const notes = useDiffNotes(location, pick, lines);
  if (diff.isPending) return <SkeletonRows count={4} />;
  if (diff.isError && !diff.data)
    return <ErrorState error={diff.error} onRetry={() => diff.refetch()} />;
  const { note, truncated, hunks, hunkable } = diff.data;
  const { add, del } = diffStats(lines);
  const bar: HunkBar = {
    canAct: hunkable && file?.kind !== "conflict",
    staged: pick.staged,
    busy: act.isPending,
    onHunk: (index) => {
      const digest = hunks[index];
      if (digest) act.mutate({ op: "hunk", path: pick.path, staged: pick.staged, index, digest });
    },
  };
  const slash = pick.path.lastIndexOf("/", pick.path.length - 2);
  const side = pick.staged
    ? "preparado"
    : file?.kind === "conflict"
      ? "en conflicto"
      : "sin preparar";
  const pickMode = (m: DiffMode) => {
    modeKey.set(m);
    onMode(m);
  };

  return (
    <section aria-label={`Diff de ${pick.path}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[12px]">
        <span
          className="min-w-0 truncate font-mono"
          title={file?.orig ? `${file.orig} → ${pick.path}` : pick.path}
        >
          {slash >= 0 && <span className="text-ink-2">{pick.path.slice(0, slash + 1)}</span>}
          <span className="font-medium">{pick.path.slice(slash + 1)}</span>
        </span>
        <span className="text-ink-2">{side}</span>
        {!pick.path.endsWith("/") && (
          <button
            type="button"
            className="nav-item h-6 gap-1 px-2 text-[12px]"
            title="Ver el fichero entero en la tile de código, en su primer cambio"
            onClick={() => {
              const first =
                lines.find((l) => l.kind === "add") ?? lines.find((l) => l.new !== null);
              openIn(location, pick.path, first?.new ?? null);
              openTile(codeTile(location), location);
            }}
          >
            <Icon name="code" size={12} />
            Abrir en Código
          </button>
        )}
        <span className="font-mono tabular-nums">
          <span className="text-ok">+{add}</span> <span className="text-bad">−{del}</span>
        </span>
        <fieldset aria-label="Vista del diff" className="ml-auto flex gap-0.5">
          {(
            [
              ["unified", "Unificado"],
              ["split", "Lado a lado"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              className="nav-item h-6 px-2 text-[12px]"
              onClick={() => pickMode(m)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </header>
      {/* A failed poll keeps the diff on screen, and says it may be old. */}
      {diff.isError && (
        <StaleNotice error={diff.error} onRetry={() => diff.refetch()} className="m-2" />
      )}
      {act.error && (
        <InlineError className="border-b border-line px-3 py-2 text-[12px]">
          {gitErrorText(act.error)}
        </InlineError>
      )}
      {truncated && (
        <p className="border-b border-line px-3 py-2 text-[12px] text-warn">
          Diff recortado a 512 KB; el resto no se muestra y no se puede preparar por hunks.
        </p>
      )}
      <div data-diff-scroll className="@container min-h-0 flex-1 overflow-auto">
        {notes.top}
        {note === "directorio" ? (
          <p className="px-4 py-3 text-[12px] text-ink-2">
            Es un directorio o un repo anidado: no tiene diff de texto.
          </p>
        ) : lines.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-ink-2">
            Sin diferencias de texto en este lado (un cambio de modo, o ya no hay cambios).
          </p>
        ) : mode === "split" ? (
          <Split lines={lines} bar={bar} notes={notes.layer} />
        ) : (
          <Unified lines={lines} bar={bar} notes={notes.layer} />
        )}
      </div>
      {notes.bar}
    </section>
  );
}
