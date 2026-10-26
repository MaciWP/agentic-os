import { expect, test } from "bun:test";
import { Hono } from "hono";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { openDb } from "../../db.ts";
import { errorHandler } from "../../errors.ts";
import { Review } from "./review.ts";
import { transcriptRoutes } from "./routes.ts";
import { Transcripts } from "./runner.ts";
import { TranscriptStore } from "./store.ts";

function app(missing: string | null = null) {
  const transcripts = new Transcripts(
    new TranscriptStore(openDb(":memory:")),
    {
      decode: async () => "",
      vad: async () => [],
      diarize: async () => [],
      alive: () => true,
      launch: async () => 0,
    },
    {
      root: `${process.env.TMPDIR ?? "/tmp"}/transcripts-routes-${crypto.randomUUID()}`,
      app: "x.app",
      bundle: "b",
      missing: () => missing,
      pollMs: 1000,
      graceMs: 1000,
      now: Date.now,
      id: () => crypto.randomUUID(),
    },
  );
  const unused = () => {
    throw new Error("not in these tests");
  };
  const review = new Review({
    recording: (id) => transcripts.get(id),
    meetings: { get: unused },
    memory: {} as never,
    addTask: unused,
    launch: unused,
    workspace: { read: unused, apply: unused },
    appRoot: "/app",
  });
  return new Hono()
    .route("/api/transcripts", transcriptRoutes({ transcripts, review }))
    .onError(errorHandler(SERVER_ERRORS));
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("start, list, get, stop and name the speakers", async () => {
  const a = app();
  const started = await a.request("/api/transcripts/start", json("POST", { speakers: 3 }));
  expect(started.status).toBe(201);
  const { recording } = (await started.json()) as { recording: { id: string } };
  expect(
    ((await (await a.request("/api/transcripts")).json()) as { recordings: unknown[] }).recordings
      .length,
  ).toBe(1);
  const named = await a.request(
    `/api/transcripts/${recording.id}/speakers`,
    json("PUT", { names: { "Speaker 1": "Ana" } }),
  );
  expect(((await named.json()) as { transcript: { names: object } }).transcript.names).toEqual({
    "Speaker 1": "Ana",
  });
  expect(
    (await a.request(`/api/transcripts/${recording.id}/stop`, { method: "POST" })).status,
  ).toBe(200);
});

test("bad bodies, unknown ids and a missing setup have their own answers", async () => {
  const a = app();
  expect((await a.request("/api/transcripts/start", json("POST", { speakers: 0 }))).status).toBe(
    400,
  );
  expect((await a.request("/api/transcripts/start", json("POST", { meetingId: 99 }))).status).toBe(
    404,
  );
  expect((await a.request("/api/transcripts/nope")).status).toBe(404);
  expect((await a.request("/api/transcripts/nope/stop", { method: "POST" })).status).toBe(404);
  expect(
    (await a.request("/api/transcripts/nope/speakers", json("PUT", { names: 1 }))).status,
  ).toBe(400);
  const off = await app("add transcripts.vad").request("/api/transcripts/start", json("POST", {}));
  expect(off.status).toBe(409);
  expect(await off.json()).toEqual({ error: "not_configured", detail: "add transcripts.vad" });
});

test("only the user decides a proposal; the agent cannot propose before the text is ready", async () => {
  const a = app();
  const started = await a.request("/api/transcripts/start", json("POST", {}));
  const { recording } = (await started.json()) as { recording: { id: string } };
  const asAgent = await a.request(`/api/transcripts/${recording.id}/proposals/abc`, {
    ...json("POST", { state: "accepted" }),
    headers: { "content-type": "application/json", "x-aos-agent-id": "t1" },
  });
  expect(asAgent.status).toBe(403);
  const early = await a.request(
    `/api/transcripts/${recording.id}/proposals`,
    json("POST", { summary: "", items: [] }),
  );
  expect(early.status).toBe(409);
  const shapeless = await a.request(
    `/api/transcripts/${recording.id}/proposals`,
    json("POST", { items: [{ kind: "wish", text: "x" }] }),
  );
  expect(shapeless.status).toBe(400);
});
