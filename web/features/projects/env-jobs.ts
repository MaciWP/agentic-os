import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { HeldTerminal } from "../../../server/features/envs/actions.ts";
import type { EnvJob, JobRequest, JobSummary } from "../../../server/features/envs/jobs.ts";
import type { RemovePreview as Losses } from "../../../server/features/envs/provider.ts";
import { api, mutate, unwrap } from "../../api.ts";
import { errorText } from "../../ui.tsx";

export type { EnvJob, HeldTerminal, JobSummary };
// What a remove would lose, and the open terminals it would close.
export type RemovePreview = Losses & { open: HeldTerminal[] };

// A running job's output is read this often while it shows; a finished one is read once.
export const JOB_POLL_MS = 1000;

// Every query here sits under "envjobs", so the server's push when a job starts or ends
// (web/events.ts) reads them all again: the list, the shown job and the status.
export function useEnvJobs() {
  return useQuery({
    queryKey: ["envjobs"],
    queryFn: async () => unwrap(await api.api.envs.jobs.$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useEnvJob(id: string) {
  return useQuery({
    queryKey: ["envjobs", "job", id],
    queryFn: async () => unwrap(await api.api.envs.jobs[":id"].$get({ param: { id } })),
    refetchInterval: (q) => (q.state.data?.job.state === "running" ? JOB_POLL_MS : false),
  });
}

// The shared services and the proxy; it shells out to the provider, so it is not polled.
export function useEnvStatus() {
  return useQuery({
    queryKey: ["envjobs", "status"],
    queryFn: async () => unwrap(await api.api.envs.status.$get()),
    staleTime: 30_000,
  });
}

// Read only when the user asks to remove the env, and again on each "Volver a revisar". Not
// under "envjobs": a job starting elsewhere must not re-run a 17 s dry run, nor change the
// losses the user is reviewing.
export function useRemovePreview(name: string, enabled: boolean) {
  return useQuery({
    queryKey: ["envpreview", name],
    queryFn: async () =>
      unwrap(await api.api.envs[":name"]["remove-preview"].$get({ param: { name } })),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

// The newest job that matches, from the list (newest first).
export const latestJob = (jobs: JobSummary[] | undefined, match: (j: JobSummary) => boolean) =>
  jobs?.find(match) ?? null;

// Starts a job; a refusal (busy env, env gone) comes back as the error, in words. Resolves
// whether the job started.
export function useStartJob() {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start(req: JobRequest): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      await mutate<{ job: JobSummary }>("/api/envs/jobs", "POST", req);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setPending(false);
      await client.invalidateQueries({ queryKey: ["envjobs"] });
    }
  }
  return { start, pending, error };
}
