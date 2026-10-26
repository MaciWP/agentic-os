import type { GitSummary } from "../git/queries.ts";
import type { TerminalInfo } from "../terminals/queries.ts";
import type { JobSummary } from "./env-jobs.ts";
import type { Projects } from "./queries.ts";
import type { Selection } from "./tree.tsx";

export type Env = Projects["envs"]["items"][number];
export type Repo = Projects["repos"][number];

export type Tree = {
  byNode: Map<string, TerminalInfo[]>;
  // Per checkout location; a node missing here shows no counts.
  git: Record<string, GitSummary>;
  selected: Selection;
  pending: boolean;
  // The row marked for the bar over the tree, and marking one.
  picked: string | null;
  pick: (id: string) => void;
  // A panel tile (git, an env's output) in the Mesa; `node` is marked when it goes there.
  openTile: (id: string, node?: string) => void;
  // Start, stop and update run in the server, without a terminal, and their jobs make the env
  // busy meanwhile; their output opens as a tile. The logs never end, so they open a terminal.
  envCommand: (action: "start" | "stop" | "update" | "logs", name: string) => void;
  envJobs: JobSummary[];
  // Why new worktrees cannot be made, when they cannot.
  worktrees: Projects["worktrees"];
};
