import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AddResult } from "../../../server/features/projects/native.ts";
import { type EnvState, envState } from "../../../shared/envs.ts";
import { api, mutate, serverCachedQuery, unwrap } from "../../api.ts";
import { useGitWrite } from "../git/queries.ts";
import { nodeKey, type TerminalInfo } from "../terminals/queries.ts";

// The env provider's list takes seconds: the server keeps it until an env command ends or
// "Actualizar" asks for a fresh one. Git's worktree lists are read on every request.
const projects = serverCachedQuery("projects", async (query) =>
  unwrap(await api.api.projects.$get({ query })),
);
export const projectsQuery = projects.query;
export type Projects = Awaited<ReturnType<typeof projectsQuery.queryFn>>;

export function useProjects() {
  const client = useQueryClient();
  return { ...useQuery(projectsQuery), refresh: () => projects.refresh(client) };
}

export type { AddResult };

// The branches a new worktree can take or start from, read when the form opens: full ref
// names, newest commit first, and the remote's default branch as the base.
export const useBranches = (repo: string) =>
  useQuery({
    queryKey: ["projects", "branches", repo],
    queryFn: async () =>
      unwrap(await api.api.projects.repos[":id"].branches.$get({ param: { id: repo } })),
  });

export const useAddWorktree = () =>
  useGitWrite((v: { repo: string; branch: string; base?: string }) =>
    mutate<AddResult>("/api/projects/worktrees", "POST", v),
  );

export const useRemoveWorktree = () =>
  useGitWrite((v: { location: string; dropIgnored?: boolean }) =>
    mutate<{ location: string; path: string; branch: string }>(
      "/api/projects/worktrees",
      "DELETE",
      v,
    ),
  );

// "Añadir repo": a folder chosen in the app's picker joins the config as a repo.
export const useAddRepo = () =>
  useGitWrite((v: { path: string }) =>
    mutate<{ id: string; location: string }>("/api/projects/repos", "POST", v),
  );

// Takes an added repo off the list; the folder stays as it is.
export const useRemoveRepo = () =>
  useGitWrite((id: string) =>
    mutate<{ ok: true }>(`/api/projects/repos/${encodeURIComponent(id)}`, "DELETE"),
  );

// The node that holds the env provider's own commands: Nuevo entorno and the ones that act on
// every env. Its id is the envs root's location, where those commands run.
// Whether an env works on a ticket: on its branch, or named after it as a create names it.
export const worksOn = (env: { name: string; branch: string | null }, key: string) =>
  env.branch === key || env.name === key.toLowerCase();

// The env a ticket works in. "unknown" while the provider failed: its empty list says nothing.
export const ticketEnv = (p: Projects, key: string) =>
  p.envs.error ? ("unknown" as const) : p.envs.items.find((e) => worksOn(e, key));

// Which node of the tree each terminal shows under, keyed by the node's location id. A terminal
// whose node is gone (an env command whose env is not listed yet or any more, a worktree
// deleted, a provider failing) goes to the loose ones, never out of sight: the app's own node
// holds them, the app's folder or, once Agentic OS is a repo, its main checkout.
export function groupTerminals(terminals: TerminalInfo[], p: Projects) {
  // «+ Claude» starts in the free folder: its terminals are placed, not loose.
  const nodes = new Set<string>(["scratch"]);
  for (const e of p.envs.items) {
    nodes.add(`env:${e.name}`);
    for (const c of e.checkouts) nodes.add(c.location);
  }
  for (const r of p.repos) {
    nodes.add(r.location);
    for (const w of r.worktrees) if (w.location) nodes.add(w.location);
  }
  const byNode = new Map<string, TerminalInfo[]>();
  const loose: TerminalInfo[] = [];
  for (const t of terminals) {
    const key = nodeKey(t);
    if (nodes.has(key)) byNode.set(key, [...(byNode.get(key) ?? []), t]);
    else loose.push(t);
  }
  if (loose.length > 0)
    byNode.set(p.app.location, [...(byNode.get(p.app.location) ?? []), ...loose]);
  return { byNode, loose };
}

// Where the tree shows each terminal: its node, and the node's label.
export function places(terminals: TerminalInfo[], p: Projects) {
  const out = new Map<string, { node: string; label: string }>();
  for (const [node, items] of groupTerminals(terminals, p).byNode) {
    const label = findNode(p, node)?.label ?? node;
    for (const t of items) out.set(t.id, { node, label });
  }
  return out;
}

// A repo's main checkout, named as its row: the repo, then the branch.
export const mainLabel = (r: Pick<Projects["repos"][number], "id" | "main">) =>
  `${r.id}/${r.main?.branch ?? "principal"}`;

export type NodeKind = "env" | "checkout" | "repo" | "worktree" | "app" | "scratch";

// The node a location id names, with its full label as the tree's aria-labels spell it; null
// when the tree has no such node (an env removed, a worktree deleted).
export function findNode(
  p: Projects,
  location: string,
): {
  label: string;
  kind: NodeKind;
  canLaunch: boolean;
  // The profile repo a repo or worktree node belongs to; removable: a worktree the app made.
  repo?: string;
  removable?: boolean;
} | null {
  // Once Agentic OS is a repo, the "app" location is that repo's main checkout.
  if (location === "app" && p.app.location !== "app") return findNode(p, p.app.location);
  if (location === "app") return { label: p.app.label, kind: "app", canLaunch: true };
  if (location === "scratch") return { label: "Carpeta libre", kind: "scratch", canLaunch: true };
  for (const e of p.envs.items) {
    if (`env:${e.name}` === location) return { label: e.name, kind: "env", canLaunch: !e.problem };
    for (const c of e.checkouts)
      if (c.location === location)
        return { label: `${e.name}/${c.dir}`, kind: "checkout", canLaunch: true };
  }
  for (const r of p.repos) {
    if (r.location === location)
      return { label: mainLabel(r), kind: "repo", canLaunch: true, repo: r.id };
    for (const w of r.worktrees)
      if (w.location === location)
        return {
          label: `${r.id}/${w.branch}`,
          kind: "worktree",
          canLaunch: true,
          repo: r.id,
          removable: w.removable,
        };
  }
  return null;
}

export { type EnvState, envState };
