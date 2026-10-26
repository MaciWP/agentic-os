import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { errorHandler } from "../../errors.ts";
import { localGuard } from "../../local-guard.ts";
import { EventBus } from "../events/bus.ts";
import type { GithubClient } from "../github/prs.ts";
import { jiraClient } from "../jira/client.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { Messenger } from "./messages.ts";
import { coordinationRoutes } from "./routes.ts";
import { ConsultationRunner } from "./runner.ts";
import { CoordinationStore } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "aos-coordination-api-"));
Bun.spawnSync(["git", "init", root]);
writeFileSync(join(root, "code.ts"), "export const answer = 42;");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const config = ConfigSchema.parse({
  providers: { jira: false, github: false },
  repos: [{ id: "test", localPath: root }],
});
const db = openDb(":memory:");
const bus = new EventBus([], 0);
const store = new CoordinationStore(db, () => bus.publish("coordination"));
let calls = 0;
const runner = new ConsultationRunner(store, async () => {
  calls++;
  return { result: "review", usage: null };
});
const agents = ["a", "b"].map((id) => ({
  id,
  harness: "claude",
  state: "running",
  startedAt: "generation",
  location: "repo:test",
})) as TerminalInfo[];
const terminals = {
  consultations: runner,
  env: Promise.resolve({ PATH: "/usr/bin:/bin" }),
  list: () => agents,
  get: (id: string) => agents.find((a) => a.id === id),
  subscribe: () => () => {},
  write: () => true,
} as unknown as Terminals;
const deps = { config, db, terminals, jira: jiraClient(db) };
// Mounted like the server mounts it: the app's error registry answers CoordinationError.
const app = new Hono()
  .use("*", localGuard([4317]))
  .route(
    "/api/coordination",
    coordinationRoutes(
      {
        ...deps,
        github: {} as GithubClient,
        bus,
        coordination: store,
        messenger: new Messenger(store, terminals),
      },
      {
        dir: join(root, "stored"),
        inspect: async () =>
          ["claude", "codex", "grok"].map((harness) => ({
            harness: harness as "claude",
            available: harness !== "grok",
            reason: null,
          })),
      },
    ),
  )
  .onError(errorHandler(SERVER_ERRORS));
const request = (
  path: string,
  method = "GET",
  data?: unknown,
  agent?: string,
  origin = "http://localhost:4317",
) =>
  app.request(`/api/coordination${path}`, {
    method,
    headers: {
      host: "localhost:4317",
      origin,
      "content-type": "application/json",
      ...(agent && { "x-aos-agent-id": agent }),
    },
    ...(data !== undefined && { body: JSON.stringify(data) }),
  });

test("guard and managed identity reject outsiders and terminal control sequences", async () => {
  expect((await request("/messages", "POST", {}, undefined, "https://evil.invalid")).status).toBe(
    403,
  );
  expect((await request("/self", "GET", undefined, "outside")).status).toBe(403);
  expect(
    (await request("/messages", "POST", { requestId: "bad", to: "b", text: "\u001b[201~" }, "a"))
      .status,
  ).toBe(400);
  expect(await (await request("/self", "GET", undefined, "a")).json()).toMatchObject({ id: "a" });
});
test("atomic reservations expose conflicts and user reservations stay active", async () => {
  const input = { location: "repo:test", paths: ["code.ts"], reason: "API" };
  expect((await request("/reservations", "POST", input, "a")).status).toBe(201);
  const conflict = await request(
    "/reservations",
    "POST",
    { ...input, paths: ["new.ts", "code.ts"] },
    "b",
  );
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error).toBe("reserved");
  const one = store.reservations()[0];
  expect((await request(`/reservations/${one?.id}`, "DELETE", {}, "b")).status).toBe(403);
  // A shortened id releases nothing, so it must not answer as if it had.
  const prefix = await request(`/reservations/${one?.id.slice(0, 8)}`, "DELETE", {}, "a");
  expect(prefix.status).toBe(404);
  expect((await prefix.json()).error).toBe("unknown_reservation");
  expect(store.reservations().some((r) => r.id === one?.id)).toBe(true);
  expect((await request(`/reservations/${one?.id}`, "DELETE", {})).status).toBe(200);
  await request("/reservations", "POST", input);
  await request("");
  expect(store.reservations()[0]?.status).toBe("active");
});
test("preparation never runs agents; exact reviewed batch approval launches once", async () => {
  // Keep consultation storage out of the captured tree using git's normal ignore rule.
  writeFileSync(join(root, ".gitignore"), "stored/\n");
  const input = {
    requestId: "q1",
    location: "repo:test",
    prompt: "Review the code",
    participants: [
      { harness: "claude", model: "test" },
      { harness: "codex", model: "test" },
    ],
  };
  const prepared = await request("/consultations", "POST", input, "a");
  expect(prepared.status).toBe(201);
  const q = await prepared.json();
  expect(q.state).toBe("pending");
  expect(calls).toBe(0);
  expect((await (await request("/consultations", "POST", input, "a")).json()).id).toBe(q.id);
  const approval = {
    fingerprint: q.fingerprint,
    attempts: q.attempts.map((a: { id: string }) => a.id),
  };
  expect((await request(`/consultations/${q.id}/approve`, "POST", approval, "a")).status).toBe(403);
  expect(
    (await request(`/consultations/${q.id}/approve`, "POST", { ...approval, fingerprint: "stale" }))
      .status,
  ).toBe(409);
  expect((await request(`/consultations/${q.id}/approve`, "POST", approval)).status).toBe(200);
  await runner.settled();
  expect(calls).toBe(2);
  expect((await request(`/consultations/${q.id}/approve`, "POST", approval)).status).toBe(409);
  expect(calls).toBe(2);
  const followup = await request(
    `/consultations/${q.id}/followup`,
    "POST",
    { kind: "synthesis", participant: { harness: "claude", model: "test" } },
    "a",
  );
  expect((await followup.json()).state).toBe("pending");
  expect(calls).toBe(2);
});
test("event waits wake on durable changes and have a bounded timeout", async () => {
  const wait = request("/wait", "POST", { after: store.revision(), timeoutMs: 1000 });
  await request("/messages", "POST", { requestId: "m1", to: "user", text: "Ready" }, "a");
  expect((await (await wait).json()).reason).toBe("changed");
  expect(
    (await (await request("/wait", "POST", { after: store.revision(), timeoutMs: 1 })).json())
      .reason,
  ).toBe("timeout");
});
test("a retried message replays its record after the recipient is gone", async () => {
  const input = { requestId: "lost-response", to: "gone", text: "Previously accepted" };
  const accepted = store.message("a", input);
  store.updateMessage(accepted.id, "delivered");
  const retry = await request("/messages", "POST", input, "a");
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({ id: accepted.id, status: "delivered" });
  const changed = await request("/messages", "POST", { ...input, text: "Other" }, "a");
  expect(changed.status).toBe(409);
  expect((await changed.json()).error).toBe("request_conflict");
  const fresh = await request("/messages", "POST", { ...input, requestId: "new" }, "a");
  expect((await fresh.json()).error).toBe("unknown_recipient");
});
