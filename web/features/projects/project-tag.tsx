import type { ReactNode } from "react";
import { projectColor } from "../../../shared/project-colors.ts";
import { useProjects } from "./queries.ts";

// A project's colour as `data-project-color`, which sets `--prj` (tokens.css): the configured
// one (config.json projectColors), else one picked by its name.
export function useProjectColor(name: string) {
  return projectColor(name, useProjects().data?.colors);
}

// A project's mark in the tree: a dot on its section's head, its colour on a repo's icon.
export function ProjectDot({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      data-project-color={useProjectColor(name)}
      className="size-2 shrink-0 rounded-full bg-[var(--prj)]"
    />
  );
}
export function ProjectIcon({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span data-project-color={useProjectColor(name)} className="grid text-[var(--prj)]">
      {children}
    </span>
  );
}

// A project's name as a tag in its colour: on a Mesa's card, its Mosaico cell and its Lienzo
// region.
export function ProjectTag({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      data-project-color={useProjectColor(name)}
      className={`project-tag truncate rounded px-1 font-sans text-[10px] uppercase tracking-wide ${className}`}
    >
      {name}
    </span>
  );
}
