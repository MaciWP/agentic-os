import { expect, test } from "bun:test";
import { Hono } from "hono";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { openDb } from "../../db.ts";
import { errorHandler } from "../../errors.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { objectiveRoutes } from "./routes.ts";
import { ObjectiveStore } from "./store.ts";

function setup(agent: TerminalInfo["agent"] = null) {
  const objectives = new ObjectiveStore(openDb(":memory:"));
  const t1 = { id: "t1", harness: "claude", ticket: "ABC-1", agent } as TerminalInfo;
  const launched = {
    subscribe: () => () => {},
    list: () => [t1],
    get: (id: string) => (id === "t1" ? t1 : undefined),
  } as unknown as Terminals;
  const app = new Hono()
    .route("/", objectiveRoutes({ objectives, launched }))
    .onError(errorHandler(SERVER_ERRORS));
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, objectives };
}

test("a goal is created, chosen for a terminal, listed and closed", async () => {
  const { call } = setup();
  const created = await call("POST", "/goals", { title: "  Refactor the host  " });
  expect(created.status).toBe(201);
  const { objective } = (await created.json()) as { objective: { id: number; title: string } };
  expect(objective.title).toBe("Refactor the host");

  const chosen = await call("PUT", "/terminals/t1", { objective: objective.id });
  expect(chosen.status).toBe(200);
  expect(await chosen.json()).toMatchObject({
    terminal: { id: "t1", ticket: null, objective: { kind: "goal", id: objective.id } },
  });

  expect(await (await call("GET", "/")).json()).toEqual({ objectives: [{ ...objective }] });
  expect((await call("POST", `/${objective.id}/close`)).status).toBe(200);
  expect(await (await call("GET", "/")).json()).toEqual({ objectives: [] });
});

test("bad input, an unknown terminal and an unknown or closed objective are refused", async () => {
  const { call } = setup();
  expect((await call("POST", "/goals", { title: "" })).status).toBe(400);
  expect((await call("PUT", "/terminals/t1", { ticket: "not a key" })).status).toBe(400);
  expect((await call("PUT", "/terminals/nope", { none: true })).status).toBe(404);
  expect((await call("PUT", "/terminals/t1", { objective: 99 })).status).toBe(404);
  expect((await call("POST", "/99/close")).status).toBe(404);
  expect((await call("POST", "/abc/close")).status).toBe(400);
  expect((await call("POST", "/99/reopen")).status).toBe(404);
  expect((await call("GET", "/tasks?from=yesterday&to=today")).status).toBe(400);
  const { objective } = (await (await call("POST", "/goals", { title: "x" })).json()) as {
    objective: { id: number };
  };
  await call("POST", `/${objective.id}/close`);
  const closed = await call("PUT", "/terminals/t1", { objective: objective.id });
  expect(closed.status).toBe(409);
  expect(await closed.json()).toMatchObject({ error: "closed" });
});

test("back to the launch ticket files the live session under it, whatever was chosen before", async () => {
  const { call, objectives } = setup({ sessionId: "s1", state: "needs_you" });
  const filed = () => objectives.sessions().get("claude:s1");
  await call("PUT", "/terminals/t1", { ticket: "ABC-2" });
  expect(filed()).toMatchObject({ kind: "ticket", ticket: "ABC-2" });
  const back = await call("PUT", "/terminals/t1", { launch: true });
  expect(await back.json()).toMatchObject({ terminal: { ticket: "ABC-1" } });
  expect(filed()).toMatchObject({ kind: "ticket", ticket: "ABC-1" });

  const { objective } = (await (await call("POST", "/goals", { title: "g" })).json()) as {
    objective: { id: number };
  };
  await call("PUT", "/terminals/t1", { objective: objective.id });
  expect(filed()).toMatchObject({ kind: "goal", id: objective.id });
  await call("PUT", "/terminals/t1", { launch: true });
  expect(filed()).toMatchObject({ kind: "ticket", ticket: "ABC-1" });
});

test("tasks: create with fields, batch, patch, and the day filter", async () => {
  const { call } = setup();
  const made = await call("POST", "/goals", {
    title: "Llamar",
    dueOn: "2026-10-20",
    dueHm: "16:00",
    priority: 1,
  });
  expect(made.status).toBe(201);
  const { task } = (await made.json()) as { task: { id: number } };
  expect((await call("POST", "/goals", { title: "x", dueHm: "16:00" })).status).toBe(400);
  expect((await call("POST", "/goals", { title: "x", source: "mail:gmail" })).status).toBe(400);

  const batch = await call("POST", "/goals/batch", {
    goals: [
      { title: "a", source: "meeting:7", sourceKey: "1" },
      { title: "b", source: "meeting:7", sourceKey: "2", dueOn: "2999-01-01" },
    ],
  });
  expect(batch.status).toBe(201);
  expect((await call("PATCH", `/${task.id}`, { priority: 0 })).status).toBe(200);
  expect((await call("PATCH", `/${task.id}`, {})).status).toBe(400);
  expect((await call("PATCH", "/999", { priority: 0 })).status).toBe(404);

  const day = new URLSearchParams({
    from: "2026-10-19T00:00:00.000Z",
    to: "2999-01-01T00:00:00.000Z",
    day: "2026-10-19",
  });
  const { tasks } = (await (await call("GET", `/tasks?${day}`)).json()) as {
    tasks: { title: string }[];
  };
  expect(tasks.map((t) => t.title)).toEqual(["a"]);
  expect((await call("GET", "/tasks?from=x&to=y")).status).toBe(400);

  // By what made them, whatever their day: what a meeting note already turned into tasks.
  const bySource = (await (await call("GET", "/tasks/source?source=meeting:7")).json()) as {
    tasks: { title: string; sourceKey: string }[];
  };
  expect(bySource.tasks.map((t) => [t.title, t.sourceKey])).toEqual([
    ["a", "1"],
    ["b", "2"],
  ]);
  expect((await call("GET", "/tasks/source?source=Meeting 7")).status).toBe(400);
});
