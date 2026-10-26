import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitSummary } from "../../../server/features/git/routes.ts";
import type { CommitResult, PushResult } from "../../../server/features/git/stage.ts";
import type { PullResult, RepoUpdate, SubmoduleSync } from "../../../server/features/git/sync.ts";
import { api, errorDetail, mutate, unwrap } from "../../api.ts";
import { pollEvery } from "../../poll.ts";

export type { CommitResult, GitSummary, PullResult, PushResult, RepoUpdate, SubmoduleSync };

// What the submodules did after a fast-forward, in one line; null when there is nothing to say.
export function submoduleText(s: SubmoduleSync | null | undefined): string | null {
  if (!s) return null;
  const parts = [
    ...(s.moved.length ? [`submódulos al día: ${s.moved.join(", ")}`] : []),
    ...s.kept.map((k) => `${k.path} sin mover: ${k.why}`),
    ...(s.error ? [`los submódulos no se han actualizado: ${s.error}`] : []),
  ];
  return parts.length ? parts.join(" · ") : null;
}

// Under the projects key: a projects push, a reconnect or the tree's "Actualizar" reads them
// again with the tree. Nothing polls; a stale copy (30 s) is read again on focus.
const GIT = ["projects", "git"] as const;

export const gitSummaryQuery = {
  queryKey: [...GIT, "summary"],
  // Hono's JSON typing drops a record's index signature.
  queryFn: async (): Promise<{ items: Record<string, GitSummary> }> =>
    unwrap(await api.api.git.summary.$get()),
};

export const gitStatusQuery = (location: string) => ({
  queryKey: [...GIT, "status", location],
  queryFn: async () => unwrap(await api.api.git.status.$get({ query: { location } })),
});
export type GitStatusAnswer = Awaited<ReturnType<ReturnType<typeof gitStatusQuery>["queryFn"]>>;
export type GitStatus = Extract<GitStatusAnswer, { repo: true }>;
export type GitFile = GitStatus["files"][number];

export const gitDiffQuery = (location: string, file: string, staged: boolean) => ({
  queryKey: [...GIT, "diff", location, file, staged],
  queryFn: async () =>
    unwrap(
      await api.api.git.diff.$get({
        query: { location, file, ...(staged && { staged: "1" }) },
      }),
    ),
});

// The git window holds no event stream (web/events.ts), so while it is visible it reads the
// status and the open diff every few seconds, as the agent monitor does: an agent's edits show
// up without a click. A hidden window reads nothing.
export const GIT_POLL_MS = 5000;
const live = (on: boolean) => (on ? { refetchInterval: pollEvery(GIT_POLL_MS) } : {});

export const useGitSummary = () => useQuery(gitSummaryQuery);
export const useGitStatus = (location: string, poll = false) =>
  useQuery({ ...gitStatusQuery(location), ...live(poll) });
export const useGitDiff = (location: string, file: string, staged: boolean, poll = false) =>
  useQuery({ ...gitDiffQuery(location, file, staged), ...live(poll) });

// The server publishes `projects` after every git write (fetch, pull, stage, commit, push,
// worktree add and remove); reading again here keeps the view that clicked from waiting on
// the push.
export function useGitWrite<V, T>(write: (v: V) => Promise<T>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSettled: () => client.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export type SyncOp = "fetch" | "pull" | "push";
export type SyncResult = PullResult | PushResult | null;

// "Buscar cambios" (fetch), "Avanzar" (fast-forward) and "Subir" (push) on one checkout.
export const useGitSync = (location: string) =>
  useGitWrite((op: SyncOp): Promise<SyncResult> => {
    if (op === "fetch") {
      return mutate<{ ok: true }>("/api/git/fetch", "POST", { location }).then(() => null);
    }
    return op === "pull"
      ? mutate<PullResult>("/api/git/pull", "POST", { location })
      : mutate<PushResult>("/api/git/push", "POST", { location });
  });

// What the stage column does to files: every path is one the status listed, and the server
// checks it against its own status again.
export type GitAction =
  | { op: "stage" | "unstage"; paths: string[] }
  | { op: "discard"; paths: string[]; versions: Record<string, string> }
  | { op: "resolve"; path: string }
  | { op: "hunk"; path: string; staged: boolean; index: number; digest: string };

export const useGitAction = (location: string) =>
  useGitWrite(({ op, ...rest }: GitAction) =>
    mutate<{ ok: true }>(`/api/git/${op}`, "POST", {
      location,
      ...rest,
      ...(op === "discard" && { confirm: true }),
    }),
  );

export const useCommit = (location: string) =>
  useGitWrite((message: string) =>
    mutate<CommitResult>("/api/git/commit", "POST", { location, message }),
  );

export const useUpdateRepos = () =>
  useGitWrite(() => mutate<{ items: RepoUpdate[] }>("/api/git/update-all", "POST"));

// A refusal or git's own error, in the server's words.
export const gitErrorText = errorDetail;
