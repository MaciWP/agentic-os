import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GoalPatch,
  NewGoal,
  Objective,
  ObjectiveChoice,
  Task,
} from "../../../shared/objectives.ts";
import { api, mutate, unwrap } from "../../api.ts";
import type { TerminalInfo } from "../terminals/queries.ts";

// Open goals, then the tickets linked so far (server/features/objectives).
export function useObjectives() {
  return useQuery({
    queryKey: ["objectives"],
    queryFn: async () => unwrap(await api.api.objectives.$get()),
  });
}

// The goals alive during one local day [from, to), as Inicio's task list. Under "objectives",
// so every change below reads it again.
export function useTasks(day: { from: string; to: string; day: string }) {
  return useQuery({
    // Kept as long as Inicio's other reads (today/queries.ts): «Hoy» comes back whole.
    gcTime: 30 * 60_000,
    queryKey: ["objectives", "tasks", day.from],
    queryFn: async () => unwrap(await api.api.objectives.tasks.$get({ query: day })),
  });
}

// Every task one origin made (a meeting note's lines), whatever its day. Under "objectives",
// so a batch reads it again.
export const tasksBySource = (source: string) => ({
  queryKey: ["objectives", "tasks", "source", source],
  queryFn: async () => unwrap(await api.api.objectives.tasks.source.$get({ query: { source } })),
});

export function useTasksBySource(source: string) {
  return useQuery(tasksBySource(source));
}

// Every change moves a terminal's ticket too: both lists are read again.
export function useObjectiveActions() {
  const client = useQueryClient();
  const settle = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["objectives"] }),
      client.invalidateQueries({ queryKey: ["terminals"] }),
    ]);
  const after = async <T>(p: Promise<T>) => {
    const out = await p;
    await settle();
    return out;
  };
  return {
    choose: (terminal: string, choice: ObjectiveChoice) =>
      after(
        mutate<{ terminal: TerminalInfo }>(
          `/api/objectives/terminals/${encodeURIComponent(terminal)}`,
          "PUT",
          choice,
        ),
      ),
    // A title alone, or a task with what was read from it (shared/task-parse.ts).
    create: (goal: string | NewGoal) =>
      after(
        mutate<{ objective: Objective; task: Task }>(
          "/api/objectives/goals",
          "POST",
          typeof goal === "string" ? { title: goal } : goal,
        ),
      ),
    createMany: (goals: NewGoal[]) =>
      after(mutate<{ tasks: Task[] }>("/api/objectives/goals/batch", "POST", { goals })),
    patch: (id: number, patch: GoalPatch) =>
      after(mutate<{ task: Task }>(`/api/objectives/${id}`, "PATCH", patch)),
    close: (id: number) =>
      after(mutate<{ objective: Objective }>(`/api/objectives/${id}/close`, "POST")),
    reopen: (id: number) =>
      after(mutate<{ objective: Objective }>(`/api/objectives/${id}/reopen`, "POST")),
  };
}
