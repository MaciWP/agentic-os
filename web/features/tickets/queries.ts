import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, mutate, serverCachedQuery, unwrap } from "../../api.ts";
import { errorText } from "../../ui.tsx";

// The server keeps the list 60 s and checks Jira while a dashboard is open. Only
// "Actualizar", "Recargar" and the retries after an error ask it for a fresh one.
const tickets = serverCachedQuery("tickets", async (query) =>
  unwrap(await api.api.tickets.$get({ query })),
);
export const ticketsQuery = tickets.query;
export const refreshTickets = tickets.refresh;

export function useTickets() {
  const client = useQueryClient();
  return { ...useQuery(ticketsQuery), refresh: () => refreshTickets(client) };
}

// The whole team's open tickets and the user's Jira account. Under "tickets", so the push
// that reads the user's list again reads this one too.
const team = serverCachedQuery(["tickets", "team"], async (query) =>
  unwrap(await api.api.tickets.team.$get({ query })),
);
export const teamQuery = team.query;

export function useTeamTickets() {
  const client = useQueryClient();
  return { ...useQuery(teamQuery), refresh: () => team.refresh(client) };
}

// One Jira board's tickets for the board view: the first configured board when `id` is
// undefined. Under "tickets" too, so the same push reads it again.
const boards = new Map<string, ReturnType<typeof boardQuery>>();
const boardQuery = (id: string | undefined) =>
  serverCachedQuery(["tickets", "board", id ?? ""], async (query) =>
    unwrap(await api.api.tickets.board.$get({ query: { ...query, ...(id ? { id } : {}) } })),
  );

export function useBoard(id: string | undefined) {
  const client = useQueryClient();
  let board = boards.get(id ?? "");
  if (!board) {
    board = boardQuery(id);
    boards.set(id ?? "", board);
  }
  const b = board;
  return { ...useQuery(b.query), refresh: () => b.refresh(client) };
}

export function useTicket(key: string | undefined) {
  return useQuery({
    queryKey: ["ticket", key],
    enabled: Boolean(key),
    queryFn: async () => unwrap(await api.api.tickets[":key"].$get({ param: { key: key ?? "" } })),
  });
}

export function useConnections() {
  return useQuery({
    queryKey: ["connections"],
    queryFn: async () => unwrap(await api.api.connections.$get()),
  });
}

// One write of «Revisar yo»: the ticket's reviewer field in Jira, or a PR on GitHub.
export type ReviewStep = { id: string; label: string; send: () => Promise<unknown> };
export type StepState = { state: "running" | "ok" | "failed"; error?: string };

export const jiraStep = (key: string): ReviewStep => ({
  id: "jira",
  label: `${key} en Jira`,
  send: () => mutate(`/api/tickets/${encodeURIComponent(key)}/reviewer`, "POST"),
});

export const prStep = (repo: string, n: number): ReviewStep => ({
  id: `${repo}#${n}`,
  label: `${repo}#${n} en GitHub`,
  send: () => mutate(`/api/github/prs/${encodeURIComponent(repo)}/${n}/reviewers`, "POST"),
});

// Runs the steps of «Revisar yo» and reports each one. Each stands alone: a failure never stops
// the others and never undoes the ones that went through. Jira first, as the user reads it;
// then the PRs together.
export async function runSteps(
  list: ReviewStep[],
  report: (id: string, s: StepState) => void,
): Promise<void> {
  for (const s of list) report(s.id, { state: "running" });
  const one = async (s: ReviewStep) => {
    try {
      await s.send();
      report(s.id, { state: "ok" });
    } catch (err) {
      report(s.id, { state: "failed", error: errorText(err) });
    }
  };
  const jira = list.filter((s) => s.id === "jira");
  for (const s of jira) await one(s);
  await Promise.all(list.filter((s) => s.id !== "jira").map(one));
}

// The steps' states for the page, a failed one kept on screen with its own retry. Every list
// that shows reviewers is read again once they end.
export function useTakeReview(ticketKey: string) {
  const client = useQueryClient();
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  async function run(list: ReviewStep[]) {
    await runSteps(list, (id, s) => setSteps((now) => ({ ...now, [id]: s })));
    await Promise.all([
      client.invalidateQueries({ queryKey: ["tickets"] }),
      client.invalidateQueries({ queryKey: ["ticket", ticketKey] }),
      client.invalidateQueries({ queryKey: ["prs"] }),
    ]);
  }
  const running = Object.values(steps).some((s) => s.state === "running");
  return { steps, run, running };
}
