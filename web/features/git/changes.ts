import { isStaged, isUnstaged } from "../../../shared/git.ts";
import { plural } from "../../format.ts";
import type { GitStatus } from "./queries.ts";

export const CODE: Record<string, string> = {
  M: "modificado",
  A: "añadido",
  D: "borrado",
  R: "renombrado",
  C: "copiado",
  T: "tipo cambiado",
  U: "en conflicto",
  "?": "nuevo",
};

// The letter's colour says what happened to the file, as editors do: added green, deleted
// red, changed amber, a conflict red.
export const TONE: Record<string, string> = {
  A: "text-ok",
  "?": "text-ok",
  D: "text-bad",
  U: "text-bad",
  M: "text-warn",
  R: "text-warn",
  C: "text-warn",
  T: "text-warn",
};

// "↑1 ↓2": commits ahead of and behind the upstream, only the ones that are not zero.
export function sync(ahead: number | null, behind: number | null) {
  const text = [ahead ? `↑${ahead}` : "", behind ? `↓${behind}` : ""].filter(Boolean).join(" ");
  const words = [
    ahead ? `${plural(ahead, "commit", "commits")} por delante` : "",
    behind ? `${plural(behind, "commit", "commits")} por detrás` : "",
  ].filter(Boolean);
  return { text, words: words.join(", ") };
}

export type Side = "conflict" | "staged" | "unstaged" | "untracked";
export type Pick = { path: string; staged: boolean };

// The files of each group, conflicts apart: a conflict is resolved, never staged by the
// plain action. New files git does not follow yet have their own group, as in Orca: staged
// or left there, they block nothing, and a staged one taken back returns to it.
export function groups(s: GitStatus) {
  const conflicts = s.files.filter((f) => f.kind === "conflict");
  const tracked = s.files.filter((f) => f.kind !== "conflict" && f.kind !== "untracked");
  return {
    conflicts,
    staged: tracked.filter(isStaged),
    unstaged: tracked.filter(isUnstaged),
    untracked: s.files.filter((f) => f.kind === "untracked"),
  };
}

// Every file row in the column's order, each with the side it shows.
export function picks(s: GitStatus): Pick[] {
  const g = groups(s);
  return [
    ...g.conflicts.map((f) => ({ path: f.path, staged: false })),
    ...g.staged.map((f) => ({ path: f.path, staged: true })),
    ...g.unstaged.map((f) => ({ path: f.path, staged: false })),
    ...g.untracked.map((f) => ({ path: f.path, staged: false })),
  ];
}

// The picked file may be gone after a refresh, or only on the other side now: the same path
// first, then the first one listed.
export function resolvePick(s: GitStatus, picked: Pick | null): Pick | null {
  const all = picks(s);
  return (
    all.find((p) => p.path === picked?.path && p.staged === picked.staged) ??
    all.find((p) => p.path === picked?.path) ??
    all[0] ??
    null
  );
}
