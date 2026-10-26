import { z } from "zod";

// The colour of a project's tag (a repo's group, else the repo: mesa-blocks.ts projectOf), as
// `--prj-<colour>` in web/tokens.css. Kept apart from the block dots so the two never read as
// the same thing.
export const PROJECT_COLORS = [
  "orange",
  "violet",
  "teal",
  "blue",
  "green",
  "rose",
  "amber",
  "slate",
] as const;
export const ProjectColor = z.enum(PROJECT_COLORS);
export type ProjectColor = z.infer<typeof ProjectColor>;
export type ProjectColors = Partial<Record<string, ProjectColor>>;

// The configured colour, else one picked by the name, so a project keeps its colour across
// reloads and devices without being configured.
export function projectColor(name: string, colors: ProjectColors = {}): ProjectColor {
  const set = colors[name];
  if (set) return set;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length] ?? "slate";
}
