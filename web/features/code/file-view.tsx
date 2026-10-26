import type { UseQueryResult } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import { ApiError } from "../../api.ts";
import { byteSize as size } from "../../format.ts";
import { machineUrl } from "../../machine.ts";
import { ErrorState, errorText, SkeletonRows, StaleNotice } from "../../ui.tsx";
import { Prose } from "../memory/prose.tsx";
import type { SaveStatus } from "./autosave.ts";
import { usePainted } from "./highlight.ts";
import { decoded, resolveLink } from "./nav.ts";
import type { CodeFile } from "./queries.ts";
import { CodeViewer } from "./viewer.tsx";

const CodeEditor = lazy(() => import("./editor.tsx"));

// What a file shows besides its code: Markdown as a document, an image as itself, an SVG as
// both, and JSON written on one line indented. On a desktop the code is the editor
// (editor.tsx), which saves; on a touch screen it is the read-only viewer.
const MARKDOWN = /\.(md|mdx|markdown)$/i;
const RASTER = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i;
const SVG = /\.svg$/i;
// A JSON file on one line past this is minified: worth an indented view.
const MINIFIED = 200;

// GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes.
const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

export const rawUrl = (location: string, path: string, version?: string) =>
  machineUrl(
    `/api/code/raw?${new URLSearchParams({ location, path, ...(version && { v: version }) })}`,
  );

// The indented form of JSON written on one line, or null when the text is not that.
export function prettyJson(path: string, text: string): string | null {
  const body = text.trim();
  if (!/\.json$/i.test(path) || body.length < MINIFIED || body.includes("\n")) return null;
  try {
    return `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
  } catch {
    return null;
  }
}

type Mode = "view" | "code";

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "Guardado",
  dirty: "Sin guardar",
  saving: "Guardando…",
  conflict: "Cambiado en disco",
  failed: "No se ha guardado",
};

// A file opened at a line (a diff, a definition) opens on its code, where the line is marked.
const firstMode = (path: string, line: number | null): Mode =>
  SVG.test(path) || (MARKDOWN.test(path) && line === null) ? "view" : "code";

// The open file below the tile's back button: its header (path, grammar, size, the view
// switch) and then the file as code, document or image. The tile keys it by file and open, so
// each open starts in that file's first mode while polls keep the reader where they are.
export function FileView({
  location,
  path,
  file,
  line,
  seq,
  back,
  children,
  onWord,
  onOpen,
}: {
  location: string;
  path: string;
  file: UseQueryResult<CodeFile>;
  line: number | null;
  seq: number;
  back: ReactNode;
  // Shown between the header and the file: the definitions list.
  children?: ReactNode;
  onWord: (name: string, line: number) => void;
  onOpen: (path: string) => void;
}) {
  const data = file.data;
  const text = data?.kind === "text" ? data.text : "";
  const [mode, setMode] = useState<Mode>(() => firstMode(path, line));
  const [formatted, setFormatted] = useState(false);
  const [dims, setDims] = useState<string | null>(null);
  const [named, setNamed] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ status: SaveStatus; error: unknown } | null>(null);
  const [formatAsk, setFormatAsk] = useState(0);
  const format = useCallback((t: string) => prettyJson(path, t), [path]);
  const onStatus = useCallback((status: SaveStatus, error: unknown) => {
    setSaving({ status, error });
  }, []);
  // A touch screen reads in the viewer: Monaco has no touch support.
  const [touch] = useState(() => matchMedia("(pointer: coarse)").matches);
  const pretty = useMemo(() => prettyJson(path, text), [path, text]);
  const shown = formatted && pretty ? pretty : text;
  const raster = RASTER.test(path);
  const switchable = data?.kind === "text" && (MARKDOWN.test(path) || SVG.test(path));
  const image = raster || (SVG.test(path) && mode === "view");
  const editing = !touch && !image && !(mode === "view" && MARKDOWN.test(path));
  const painted = usePainted(path, editing ? null : shown);
  const gone = file.error instanceof ApiError && file.error.code === "not_found";
  const slash = path.lastIndexOf("/");

  // Links and images inside the checkout open here; `#heading` scrolls to that heading in the
  // document; other sites open in a new tab, and their images, which the page's CSP never
  // loads, become links.
  const components = useMemo<Components>(
    () => ({
      a: ({ node: _, href = "", children: body, ...p }) => {
        const inside = resolveLink(path, href);
        const anchor = href.startsWith("#") ? slug(decoded(href.slice(1))) : null;
        return (
          <a
            {...p}
            href={href}
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            {...(anchor !== null
              ? {
                  onClick: (e) => {
                    e.preventDefault();
                    const doc = e.currentTarget.closest("section");
                    const headings = doc?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [];
                    [...headings]
                      .find((h) => slug(h.textContent ?? "") === anchor)
                      ?.scrollIntoView();
                  },
                }
              : inside
                ? {
                    onClick: (e) => {
                      e.preventDefault();
                      onOpen(inside);
                    },
                  }
                : { target: "_blank", rel: "noreferrer" })}
          >
            {body}
          </a>
        );
      },
      img: ({ node: _, src = "", alt = "" }) => {
        const inside = typeof src === "string" ? resolveLink(path, src) : null;
        return inside ? (
          <img src={rawUrl(location, inside)} alt={alt} className="max-w-full rounded-md" />
        ) : (
          <a href={String(src)} target="_blank" rel="noreferrer" className="text-primary underline">
            {alt || String(src)}
          </a>
        );
      },
    }),
    [location, path, onOpen],
  );

  return (
    <>
      <header className="flex shrink-0 items-center gap-x-3 border-line border-b px-3 py-2 text-[12px]">
        {back}
        <span className="min-w-0 truncate font-mono" title={path}>
          {slash >= 0 && <span className="text-ink-2">{path.slice(0, slash + 1)}</span>}
          <span className="font-medium">{path.slice(slash + 1)}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-ink-2">
          {data && (
            <span>
              {[
                image
                  ? (dims ?? "Imagen")
                  : data.kind === "text" && ((editing ? named : painted?.name) ?? "…"),
                data.kind === "text" &&
                  !editing &&
                  painted?.lang &&
                  !painted.tokens &&
                  "sin color (fichero grande)",
                size(data.size),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          {editing && data?.kind === "text" && (
            <span
              role="status"
              className={
                saving?.status === "failed" || saving?.status === "conflict" ? "text-warn" : ""
              }
              title={saving?.status === "failed" ? errorText(saving.error) : undefined}
            >
              {!data.editable ? "Solo lectura" : SAVE_LABEL[saving?.status ?? "saved"]}
            </span>
          )}
          {pretty && mode === "code" && (!editing || (data?.kind === "text" && data.editable)) && (
            // In the editor it indents the file, as one undoable edit; in the viewer it only
            // shows it indented.
            <button
              type="button"
              aria-pressed={editing ? undefined : formatted}
              className="nav-item h-6 px-2 text-[12px]"
              title={
                editing
                  ? "Sangrar el JSON en el fichero (⌘Z lo deshace)"
                  : "Ver el JSON sangrado; el fichero no cambia"
              }
              onClick={() => (editing ? setFormatAsk((n) => n + 1) : setFormatted((f) => !f))}
            >
              Formatear
            </button>
          )}
          {switchable && (
            <fieldset aria-label="Cómo se ve el fichero" className="flex gap-0.5">
              {(
                [
                  ["view", "Vista"],
                  ["code", "Código"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  className="nav-item h-6 px-2 text-[12px]"
                  onClick={() => setMode(m)}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          )}
        </span>
      </header>
      {children}
      {file.isPending ? (
        <SkeletonRows count={4} />
      ) : file.isError && !data ? (
        <ErrorState error={file.error} onRetry={() => file.refetch()} />
      ) : !data ? null : (
        <>
          {/* A failed poll keeps the file on screen: gone, or maybe old. */}
          {gone ? (
            <p
              role="status"
              className="m-2 rounded-md border border-line px-3 py-2 text-[12px] text-warn"
            >
              Este fichero ya no existe: lo que ves es la última versión leída.
            </p>
          ) : (
            file.isError && (
              <StaleNotice error={file.error} onRetry={() => file.refetch()} className="m-2" />
            )
          )}
          {image ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
              style={{
                backgroundImage:
                  "conic-gradient(var(--line) 25%, transparent 0 50%, var(--line) 0 75%, transparent 0)",
                backgroundSize: "16px 16px",
              }}
            >
              <img
                src={rawUrl(location, path, data.version)}
                alt={path}
                className="max-h-full max-w-full object-contain"
                onLoad={(e) =>
                  setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} px`)
                }
              />
            </div>
          ) : data.kind !== "text" ? (
            <p className="px-4 py-3 text-[12px] text-ink-2">
              {data.kind === "binary"
                ? `Fichero binario de ${size(data.size)}: no se muestra.`
                : `Fichero de ${size(data.size)}: pasa del límite de 1 MB del visor.`}
            </p>
          ) : mode === "view" && MARKDOWN.test(path) ? (
            <section
              aria-label={`Vista de ${path}`}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region takes focus so the keyboard can scroll it
              tabIndex={0}
              className="min-h-0 flex-1 overflow-auto px-6 py-5 focus-visible:-outline-offset-2"
            >
              <Prose text={text} components={components} />
            </section>
          ) : editing ? (
            <Suspense fallback={<SkeletonRows count={4} />}>
              <CodeEditor
                location={location}
                path={path}
                label={`Código de ${path}`}
                file={data}
                line={line}
                formatAsk={formatAsk}
                format={format}
                refetch={() => file.refetch().then((r) => r.data)}
                onWord={onWord}
                onName={setNamed}
                onStatus={onStatus}
              />
            </Suspense>
          ) : (
            <CodeViewer
              label={`Código de ${path}`}
              text={shown}
              tokens={painted?.tokens ?? null}
              line={formatted ? null : line}
              seq={seq}
              onWord={onWord}
            />
          )}
        </>
      )}
    </>
  );
}
