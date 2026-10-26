import type { CSSProperties } from "react";
import { ProjectTag } from "../projects/project-tag.tsx";
import { arrowFocus } from "./arrow-focus.ts";
import { HarnessLogo } from "./logos.tsx";
import { byBlock } from "./mesa-blocks.ts";
import { MesaStatus, type MesaSummary, mesaAge } from "./mesa-view.tsx";
import type { Workspace } from "./mesas.ts";
import { waitColor } from "./panel.tsx";
import { kindLabel } from "./queries.ts";

// A cell's frame: quiet at rest, its wait's colour (`--kc`) while it waits on the user, the
// accent around the open Mesa.
const CELL_REST = "border-[color-mix(in_oklab,var(--line)_70%,transparent)] bg-[var(--panel)]";
const CELL_WAITS =
  "border-[color-mix(in_oklab,var(--kc)_55%,transparent)] bg-[color-mix(in_oklab,var(--kc)_8%,var(--panel))]";

// Every Mesa as a 62 px cell, a row per block. The cells keep the list's order, so a Mesa
// stays where it was; its colour says when it waits. Enter or a click opens it.
export function Mosaic({
  summaries,
  workspace,
  onOpen,
}: {
  summaries: MesaSummary[];
  workspace: Workspace;
  onOpen: (mesa: string) => void;
}) {
  const bands = byBlock(summaries, workspace);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrows only move the focus between the cells, which are the buttons
    <div
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      onKeyDown={(e) => arrowFocus(e, "[data-cell]")}
    >
      <div className="flex flex-col gap-5">
        {bands.map((b) => (
          <section key={b.key} aria-label={b.name} className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 font-semibold text-[12px] text-ink-2">
              <span
                aria-hidden
                data-block={b.color ?? undefined}
                className={`size-2 rounded-full ${b.color ? "bg-[var(--blk)]" : "border border-line"}`}
              />
              {b.name}
              <span className="font-normal tabular-nums">{b.items.length}</span>
            </h2>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
              {b.items.map((v) => (
                <li key={v.mesa.id} className="min-w-0">
                  <Cell v={v} open={v.mesa.id === workspace.activeId} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function Cell({
  v,
  open,
  onOpen,
}: {
  v: MesaSummary;
  open: boolean;
  onOpen: (mesa: string) => void;
}) {
  const age = mesaAge(v);
  return (
    <button
      type="button"
      data-cell
      data-mesa-cell={v.mesa.id}
      data-wait={v.loud ?? undefined}
      aria-current={open || undefined}
      title={`${v.hover}${v.where ? `\n${v.where}` : ""}`}
      style={v.loud ? ({ "--kc": waitColor(v.loud) } as CSSProperties) : undefined}
      onClick={() => onOpen(v.mesa.id)}
      className={`flex h-[62px] w-full min-w-0 flex-col justify-center gap-1 rounded-[9px] border px-2.5 text-left text-[12px] hover:bg-[var(--hover)] aria-[current]:ring-1 aria-[current]:ring-[var(--accent)] ${v.loud ? CELL_WAITS : CELL_REST}`}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          title={v.lead ? kindLabel(v.lead) : undefined}
          className="grid w-3 shrink-0"
        >
          {v.lead && <HarnessLogo kind={v.lead.harness} size={12} />}
        </span>
        {v.icon && <span aria-hidden>{v.icon}</span>}
        {v.badge && <span className="pill h-4 shrink-0 px-1 font-mono text-[10px]">{v.badge}</span>}
        {v.text && (
          <span
            className={`min-w-0 truncate text-[13px] ${v.rank === 3 ? "text-ink-2" : "font-medium"}`}
          >
            {v.text}
          </span>
        )}
        <MesaStatus v={v} />
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 pl-[18px] text-[11px] text-ink-2">
        {v.project && <ProjectTag name={v.project} />}
        <span className="shrink-0">{v.mesa.ids.length ? age : "Sin terminales"}</span>
      </span>
    </button>
  );
}
