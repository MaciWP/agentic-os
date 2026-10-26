import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Proposals } from "../../../server/features/transcripts/proposals.ts";
import { api, mutate, unwrap } from "../../api.ts";

export type { Proposals };
export type ProposalView = Proposals["items"][number];

// A recording still capturing or transcribing is read this often while its tile shows; a
// ready one, once. The agent's proposals are read the same way until they arrive, for as long
// as a review run plausibly takes from its start.
export const REC_POLL_MS = 5000;
const REVIEW_WAIT_MS = 30 * 60_000;

// Every query here sits under "transcripts", so a change reads them all again.
export function useRecording(id: string) {
  return useQuery({
    queryKey: ["transcripts", id],
    queryFn: async () => unwrap(await api.api.transcripts[":id"].$get({ param: { id } })),
    refetchInterval: (q) => {
      const status = q.state.data?.transcript.status;
      return status === "ready" || status === "failed" ? false : REC_POLL_MS;
    },
  });
}

export function useProposals(id: string) {
  return useQuery({
    queryKey: ["transcripts", id, "proposals"],
    queryFn: async () => unwrap(await api.api.transcripts[":id"].proposals.$get({ param: { id } })),
    refetchInterval: (q) => {
      const at = q.state.data?.reviewAt;
      return q.state.data?.proposals === null && at && Date.now() - Date.parse(at) < REVIEW_WAIT_MS
        ? REC_POLL_MS
        : false;
    },
  });
}

export function useRecordingActions(id: string) {
  const client = useQueryClient();
  const path = `/api/transcripts/${encodeURIComponent(id)}`;
  const settle = () => client.invalidateQueries({ queryKey: ["transcripts", id] });
  return {
    stop: useMutation({ mutationFn: () => mutate(`${path}/stop`, "POST"), onSettled: settle }),
    review: useMutation({ mutationFn: () => mutate(`${path}/review`, "POST"), onSettled: settle }),
    names: useMutation({
      mutationFn: (names: Record<string, string>) => mutate(`${path}/speakers`, "PUT", { names }),
      onSettled: settle,
    }),
    decide: useMutation({
      mutationFn: (d: { item: string; state: "accepted" | "discarded"; text?: string }) =>
        mutate(`${path}/proposals/${encodeURIComponent(d.item)}`, "POST", {
          state: d.state,
          ...(d.text ? { text: d.text } : {}),
        }),
      // An accepted action is a new task: Inicio's list reads it again.
      onSettled: () =>
        Promise.all([settle(), client.invalidateQueries({ queryKey: ["objectives"] })]),
    }),
  };
}
