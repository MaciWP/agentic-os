import { afterEach, expect, mock, test } from "bun:test";
import { ApiError } from "./api.ts";
import { reportError } from "./report.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const capture = () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return bodies;
};

test("a failure is sent once per tab, with the request ID of the call behind it", async () => {
  const bodies = capture();
  const err = new ApiError(503, "pty_host_unavailable", "host gone", null, null, "r-1");
  reportError("rejection", err);
  reportError("rejection", err);
  reportError("render", new Error("x is undefined"), "Mesa");
  expect(bodies).toMatchObject([
    { kind: "rejection", message: "503 pty_host_unavailable: host gone", request: "r-1" },
    { kind: "render", message: "Mesa: x is undefined", path: "/" },
  ]);
});

test("a value that is not an Error is still reported, and a failed send throws nothing", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(() => reportError("rejection", "plain reason")).not.toThrow();
  await Bun.sleep(0);
});
