import { Hono } from "hono";
import {
  GoalPatch,
  NewGoal,
  NewGoals,
  ObjectiveChoice,
  TaskDay,
  TaskSource,
} from "../../../shared/objectives.ts";
import type { Services } from "../../deps.ts";
import { goalOf } from "./store.ts";

export function objectiveRoutes({
  objectives,
  launched,
}: Pick<Services, "objectives" | "launched">) {
  return new Hono()
    .get("/", (c) => c.json({ objectives: objectives.list() }))
    .post("/goals", async (c) => {
      const body = NewGoal.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const task = objectives.addTask(body.data);
      return c.json({ objective: goalOf(task), task }, 201);
    })
    .post("/goals/batch", async (c) => {
      const body = NewGoals.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      return c.json({ tasks: objectives.addTasks(body.data.goals) }, 201);
    })
    .get("/tasks", (c) => {
      const day = TaskDay.safeParse(c.req.query());
      if (!day.success) return c.json({ error: "bad_request", detail: day.error.issues }, 400);
      return c.json({ tasks: objectives.tasks(day.data.from, day.data.to, day.data.day) });
    })
    .get("/tasks/source", (c) => {
      const source = TaskSource.safeParse(c.req.query("source"));
      if (!source.success) return c.json({ error: "bad_request" }, 400);
      return c.json({ tasks: objectives.bySource(source.data) });
    })
    .patch("/:id", async (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_request" }, 400);
      const body = GoalPatch.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      return c.json({ task: objectives.patchTask(id, body.data) });
    })
    .post("/:id/close", (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_request" }, 400);
      return c.json({ objective: objectives.close(id) });
    })
    .post("/:id/reopen", (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_request" }, 400);
      return c.json({ objective: objectives.reopen(id) });
    })
    .put("/terminals/:id", async (c) => {
      const body = ObjectiveChoice.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      // The launch ticket, not the effective one: «El del lanzamiento» files the session there.
      const t = await launched.get(c.req.param("id"));
      if (!t) return c.json({ error: "not_found" }, 404);
      objectives.choose(t, body.data);
      return c.json({ terminal: objectives.decorate(t) });
    });
}
