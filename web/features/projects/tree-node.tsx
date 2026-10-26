import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Tip } from "@/components/ui/tooltip";
import { Icon } from "../../icons.tsx";
import { storageKey } from "../../storage.ts";
import { Fold, useOpen } from "../../ui.tsx";
import { GitCounts } from "../git/panel.tsx";
import { HarnessLogo } from "../terminals/logos.tsx";
import {
  HARNESS_LABEL,
  HARNESSES,
  type Harness,
  LOCAL_LABEL,
  type TerminalInfo,
} from "../terminals/queries.ts";
import type { Tree } from "./tree-types.ts";

export const running = (ts: TerminalInfo[]) => ts.filter((t) => t.state === "running").length;

// What a folded node still says: how many terminals run inside it. A terminal icon and the
// number, so an env's row keeps room for its commands in a 300px rail.
export const RunningCount = ({ n }: { n: number }) =>
  n > 0 ? (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-ink-2 tabular-nums"
      title={`${n} en marcha dentro`}
    >
      <Icon name="terminal" size={11} />
      {n}
      <span className="sr-only"> en marcha</span>
    </span>
  ) : null;

// What the bar over the tree opens in the row picked below it: a harness, Claude on the PC's
// model (only with one configured), the checkout's git, or its code.
export const TOOLS = ["claude", "local", "codex", "grok", "shell", "git", "code"] as const;
export type Tool = (typeof TOOLS)[number];
// The row picked to launch in, kept in this browser; "" for none.
export const pickedNode = storageKey("aos.projects.picked", { schema: z.string(), fallback: "" });
export const isHarness = (tool: Tool): tool is Harness =>
  (HARNESSES as readonly string[]).includes(tool);
export const TOOL_LABEL: Record<Tool, string> = {
  claude: HARNESS_LABEL.claude,
  local: LOCAL_LABEL,
  codex: HARNESS_LABEL.codex,
  grok: HARNESS_LABEL.grok,
  shell: HARNESS_LABEL.shell,
  git: "Git",
  code: "Código",
};
export const ToolIcon = ({ tool, size = 14 }: { tool: Tool; size?: number }) =>
  tool === "local" ? (
    <span className="relative grid">
      <HarnessLogo kind="claude" size={size} />
      <span className="absolute -right-1 -bottom-1 rounded-sm bg-panel px-px font-semibold text-[7px] leading-none">
        PC
      </span>
    </span>
  ) : isHarness(tool) ? (
    <HarnessLogo kind={tool} size={size} />
  ) : (
    <Icon name={tool} size={size} />
  );

// The bar over the tree: each tool opens in the row picked below, so a row carries no launch
// buttons of its own. `local`: whether the PC's model is configured; `refused`: why a tool
// cannot open there now.
export function ToolBar({
  picked,
  busy,
  local,
  refused,
  onRun,
}: {
  picked: { id: string; label: string } | null;
  // A launch on its way: one at a time.
  busy: boolean;
  local: boolean;
  refused: (t: Tool) => string | null;
  onRun: (t: Tool) => void;
}) {
  return (
    // The marked row shows what the icons open in: its background differs. min-w-0: a fieldset
    // is never narrower than its content otherwise, and would overflow the rail.
    <fieldset aria-label="Abrir en la fila marcada" className="flex min-w-0 items-center gap-0.5">
      {TOOLS.filter((t) => local || t !== "local").map((t) => {
        const why = picked ? refused(t) : "Marca abajo un entorno o un repositorio";
        const name = picked ? `${TOOL_LABEL[t]} en ${picked.label}` : TOOL_LABEL[t];
        return (
          <Tip key={t} label={`${name}, en la mesa`} side="bottom">
            <button
              type="button"
              className="btn-ghost shrink-0 px-1"
              aria-label={name}
              // A disabled button shows no tooltip, so it says why in its title.
              title={why ?? undefined}
              disabled={Boolean(why) || busy}
              onClick={() => onRun(t)}
            >
              <ToolIcon tool={t} />
            </button>
          </Tip>
        );
      })}
    </fieldset>
  );
}

// One place to work: a row that a click marks, so the bar over the tree opens its tools
// there, with "⋯" for the rest of what it offers, then the places nested inside. The name,
// then what it says beside it (branch, tag, git counts, the terminals running), which gives
// way first; `actions` stay in sight at its end. `hoverActions` show in a line under it while
// the pointer or the focus is on the row (always on a touch screen).
// Anything inside folds under the chevron, kept per browser; the node a link points at, and
// the ones holding it, unfold when it arrives. `label` tells same-named nodes apart for screen
// readers and names the row in the bar.
export function Node({
  id,
  name,
  label = name,
  mono = true,
  icon,
  title,
  canLaunch,
  picks,
  canOpen = true,
  defaultOpen = true,
  holds = false,
  detail,
  tag,
  actions,
  hoverActions,
  more,
  under,
  folded,
  info,
  nested = [],
  className = "",
  tree,
}: {
  id: string;
  name: string;
  label?: string;
  // Off for a display name; dirs and branches are ids.
  mono?: boolean;
  // Before the name: what kind of place it is.
  icon?: ReactNode;
  title?: string;
  // Whether a click marks it for the bar over the tree.
  canLaunch: boolean;
  // A heading that launches nothing itself: a click marks this place inside it, and unfolds it.
  picks?: { id: string; label: string };
  // Off when `id` is not a node a link can point at.
  canOpen?: boolean;
  defaultOpen?: boolean;
  // A node nested inside is the one a link points at.
  holds?: boolean;
  detail?: ReactNode;
  // What the row is (a main checkout, a worktree): always in sight, right after the name.
  tag?: ReactNode;
  // Always in sight at the row's end: an env checkout's web.
  actions?: ReactNode;
  // The row's own commands, in a line under it on hover or focus.
  hoverActions?: ReactNode;
  // What "⋯" shows under the row; no "⋯" without it.
  more?: ReactNode;
  // A second line under the name, open or folded.
  under?: ReactNode;
  // What the row says while folded; by default how many of its own terminals run.
  folded?: ReactNode;
  info?: ReactNode;
  nested?: ReactNode[];
  // How the node's own block looks in the list: an env sets itself apart from the repos.
  className?: string;
  tree: Tree;
}) {
  // What "⋯" shows under the row.
  const [moreOpen, setMoreOpen] = useState(false);
  const current = canOpen && tree.selected.node === id;
  const marked = canLaunch && tree.picked === id;
  const reveal = current || holds;
  // A link pointing here, or inside, unfolds the node; the user can fold it again.
  const [open, toggle, setOpen] = useOpen(`node:${id}`, defaultOpen, reveal);
  const body = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const terminals = tree.byNode.get(id) ?? [];
  const hasBody = Boolean(info) || nested.length > 0;
  const shown = hasBody && open;
  // The name keeps its room first; the branch, the state and the counts beside it give way.
  const nameClass = `min-w-0 shrink truncate font-medium text-[12px] text-ink ${mono ? "font-mono" : ""}`;
  const target = canLaunch ? id : picks?.id;
  const pick = () => {
    if (!target) return;
    tree.pick(target);
    if (picks && hasBody) setOpen(true);
  };
  return (
    <li className={className}>
      <div className="group/node">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the name is the row's keyboard target; this only widens the click to the whole row. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: same: the name button marks it from the keyboard. */}
        <div
          ref={rowRef}
          data-node={id}
          data-marked={marked || undefined}
          aria-current={current || undefined}
          className={`flex min-h-7 items-center gap-x-1 rounded px-1 ${target ? "cursor-pointer hover:bg-[var(--hover)]" : ""} ${current || marked ? "bg-[var(--selected)] hover:bg-[var(--selected)]" : ""}`}
          onClick={(e) => {
            if (!target || (e.target as HTMLElement).closest("button, a")) return;
            pick();
          }}
        >
          {hasBody ? (
            <Fold open={shown} onToggle={toggle} label={label} controls={body} />
          ) : (
            <span aria-hidden className="size-5 shrink-0" />
          )}
          {icon && (
            <span aria-hidden className="grid shrink-0 text-ink-2">
              {icon}
            </span>
          )}
          {target ? (
            <button
              type="button"
              className={`${nameClass} text-left`}
              aria-pressed={canLaunch ? marked : tree.picked === target}
              aria-label={
                picks && !canLaunch ? `Marcar ${picks.label} desde ${label}` : `Marcar ${label}`
              }
              title={title ? `${title}\nMárcalo y ábrelo con la barra de arriba` : undefined}
              onClick={pick}
            >
              <span className="block truncate">{name}</span>
            </button>
          ) : hasBody ? (
            <button
              type="button"
              className={`${nameClass} text-left hover:underline`}
              aria-expanded={shown}
              aria-controls={body}
              title={title}
              onClick={toggle}
            >
              <span className="block truncate">{name}</span>
            </button>
          ) : (
            <span className={nameClass} title={title}>
              {name}
            </span>
          )}
          {tag}
          {/* No room of its own: it never pushes the buttons off the row. One line high, so
              what does not fit wraps out of sight whole instead of showing cut. */}
          <span className="flex h-4 min-w-0 flex-1 basis-0 flex-wrap items-center gap-x-1 overflow-hidden">
            {detail}
            <GitCounts s={tree.git[id]} />
            {!shown && folded ? folded : <RunningCount n={running(terminals)} />}
          </span>
          {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
          {more && (
            <button
              type="button"
              className={`btn-ghost shrink-0 px-1 ${moreOpen ? "" : "opacity-0 group-focus-within/node:opacity-100 group-hover/node:opacity-100 [@media(hover:none)]:opacity-100"}`}
              aria-expanded={moreOpen}
              aria-label={`Más acciones en ${label}`}
              title="Más acciones"
              onClick={() => setMoreOpen(!moreOpen)}
            >
              ⋯
            </button>
          )}
        </div>
        {hoverActions && (
          // Keyboard focus only: a mouse click elsewhere would hide it mid-click and shift the tree.
          // biome-ignore lint/a11y/useSemanticElements: a strip of actions, not a form's fields
          <div
            role="group"
            aria-label={`Acciones de ${label}`}
            className={`flex-wrap items-center gap-0.5 pb-0.5 pl-7 ${marked || current ? "flex" : "hidden group-has-[:focus-visible]/node:flex group-hover/node:flex [@media(hover:none)]:flex"}`}
          >
            {hoverActions}
          </div>
        )}
      </div>
      {under && <div className="truncate pr-2 pb-1 pl-8 text-[11px] text-ink-2">{under}</div>}
      {moreOpen && more && (
        // biome-ignore lint/a11y/useSemanticElements: a strip of actions, not a form's fields
        <div
          role="group"
          aria-label={`Más acciones en ${label}`}
          className="flex flex-wrap items-center gap-1 px-2 pb-1 pl-6"
        >
          {more}
        </div>
      )}
      {shown && (
        <div id={body}>
          {info}
          {nested.length > 0 && <ul className="ml-3 border-l border-line pl-1">{nested}</ul>}
        </div>
      )}
    </li>
  );
}
