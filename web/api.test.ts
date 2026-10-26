import { expect, test } from "bun:test";
import { ApiError, unwrap } from "./api.ts";

test("a failed call keeps the server's code, detail and request ID", async () => {
  const res = new Response(JSON.stringify({ error: "pty_host_unavailable", detail: "host gone" }), {
    status: 503,
    headers: { "x-request-id": "r-1" },
  });
  const err = await unwrap(res).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 503, code: "pty_host_unavailable", requestId: "r-1" });
  expect((err as ApiError).message).toBe("503 pty_host_unavailable: host gone");
});
