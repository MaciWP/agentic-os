import { afterEach, expect, test } from "bun:test";
import { memoryStorage } from "../../test-storage.ts";
import { createTerminal, pendingLaunches } from "./queries.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answering = (status: number, body: unknown, sent: string[]) => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { requestId: string }).requestId);
    return Response.json(body, { status });
  }) as typeof fetch;
};

test("a refused launch is forgotten, so the next click is a new request", async () => {
  const sent: string[] = [];
  answering(400, { error: "launch_rejected", detail: "at most 12 terminals" }, sent);
  await expect(createTerminal("shell", "refused")).rejects.toThrow("launch_rejected");
  await expect(createTerminal("shell", "refused")).rejects.toThrow("launch_rejected");
  expect(sent).toHaveLength(2);
  expect(sent[0]).not.toBe(sent[1]);
});

test("an unconfirmed launch keeps its request id for the retry", async () => {
  const sent: string[] = [];
  answering(502, { error: "host_unavailable", detail: "" }, sent);
  await expect(createTerminal("shell", "unconfirmed")).rejects.toThrow();
  await expect(createTerminal("shell", "unconfirmed")).rejects.toThrow();
  expect(sent).toHaveLength(2);
  expect(sent[0]).toBe(sent[1]);
});

test("a launch left pending by a reload of the tab is retried with its id, then forgotten", async () => {
  const key = JSON.stringify({ harness: "shell", location: "reloaded" });
  const id = crypto.randomUUID();
  const disk = memoryStorage("session", { [`aos.launch:${key}`]: id });
  try {
    expect(pendingLaunches.ids()).toEqual([key]);
    const sent: string[] = [];
    answering(201, { terminal: {} }, sent);
    await createTerminal("shell", "reloaded");
    expect(sent).toEqual([id]);
    expect(pendingLaunches.ids()).toEqual([]);
  } finally {
    disk.restore();
  }
});
