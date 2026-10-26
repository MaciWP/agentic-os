import { z } from "zod";
import { PageBar } from "../../page-bar.tsx";
import { storageKey } from "../../storage.ts";
import { ErrorState } from "../../ui.tsx";
import { Canvas } from "./canvas.tsx";
import { SEGMENT } from "./mesa-rail.tsx";
import { useMesaSummaries } from "./mesa-view.tsx";
import type { Workspace } from "./mesas.ts";
import { Mosaic } from "./mosaic.tsx";

// How the Mesa page shows the Mesas: the open one's terminals, every Mesa as a cell, or every
// terminal of every Mesa on a canvas. The URL carries the last two (`?view=`), so the
// browser's Back returns to them; the last one seen is kept here for a plain visit.
export const MESA_VIEWS = [
  { key: "terminales", label: "Terminales" },
  { key: "mosaico", label: "Mosaico" },
  { key: "lienzo", label: "Lienzo" },
] as const;
export type MesaView = (typeof MESA_VIEWS)[number]["key"];
export type Overview = Exclude<MesaView, "terminales">;
export const OVERVIEWS = ["mosaico", "lienzo"] as const satisfies readonly Overview[];
export const mesaView = storageKey("aos.mesa.view", {
  schema: z.enum(["terminales", ...OVERVIEWS]),
  fallback: "terminales",
});
export const viewName = (v: MesaView) => MESA_VIEWS.find((x) => x.key === v)?.label ?? v;

// The three views as one segmented control, beside the page's title. Not on a narrow screen,
// which shows one tile at a time.
export function ViewSwitch({ view, onView }: { view: MesaView; onView: (v: MesaView) => void }) {
  return (
    <fieldset
      aria-label="Vista de la Mesa"
      className="hidden items-center gap-0.5 rounded-md border border-line p-0.5 md:flex"
    >
      {MESA_VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          aria-pressed={view === v.key}
          className={SEGMENT}
          onClick={() => onView(v.key)}
        >
          {v.label}
        </button>
      ))}
    </fieldset>
  );
}

// Mosaico or Lienzo: every Mesa at once. A click opens a Mesa (or one of its terminals) in
// Terminales.
export function MesaOverview({
  view,
  workspace,
  onView,
  onOpen,
}: {
  view: Overview;
  workspace: Workspace;
  onView: (v: MesaView) => void;
  onOpen: (mesa: string, tile?: string) => void;
}) {
  const s = useMesaSummaries(workspace);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar>
        <h1 className="font-semibold">Mesa</h1>
        <ViewSwitch view={view} onView={onView} />
      </PageBar>
      {/* Rule 3: a failed read is an error, never an empty view. */}
      {s.read.isError && !s.read.data ? (
        <div className="p-3">
          <ErrorState
            title="No se han podido leer las terminales"
            error={s.read.error}
            onRetry={() => void s.read.refetch()}
          />
        </div>
      ) : !s.read.data ? (
        <p role="status" className="p-3 text-ink-2">
          Leyendo las terminales…
        </p>
      ) : view === "mosaico" ? (
        <Mosaic summaries={s.views} workspace={workspace} onOpen={onOpen} />
      ) : (
        <Canvas
          summaries={s.views}
          workspace={workspace}
          terminals={s.terminals}
          waiting={s.waiting}
          placeOf={s.placeOf}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}
