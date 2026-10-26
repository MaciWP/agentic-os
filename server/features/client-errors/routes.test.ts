import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { clientErrorRoutes } from "./routes.ts";

let spy: Mock<(...args: unknown[]) => void>;
beforeEach(() => {
  spy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => spy.mockRestore());
const lines = () => spy.mock.calls.map((c) => String(c[0]));

let at = 0;
const app = clientErrorRoutes(() => at);
const send = (body: unknown) =>
  app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a tab's failure is one web line with its page, request and stack, never a query", async () => {
  const res = await send({
    kind: "rejection",
    message: "fetch failed at https://h.test/cb?code=secret",
    stack: "Error\n    at x (http://h.test/assets/a.js?v=1:1:2)",
    path: "/mesa",
    request: "r-1",
  });
  expect(res.status).toBe(204);
  const [line, ...rest] = lines();
  expect(rest).toEqual([]);
  expect(line).toContain("ERROR web: rejection: fetch failed at https://h.test/cb path=/mesa");
  expect(line).toContain("request=r-1");
  expect(line).not.toContain("secret");
  expect(line).not.toContain("v=1");
});

test("the same failure again within a minute adds no line", async () => {
  const report = { kind: "error", message: "boom", path: "/" };
  at = 100_000;
  await send(report);
  at = 130_000;
  expect((await send(report)).status).toBe(204);
  expect(lines()).toHaveLength(1);
  at = 161_000;
  await send(report);
  expect(lines()).toHaveLength(2);
});

test("a body that is not a report is refused and leaves no line", async () => {
  expect((await send({ kind: "error", message: "", path: "/" })).status).toBe(400);
  expect((await send({ kind: "nope", message: "x", path: "/" })).status).toBe(400);
  expect((await send({ kind: "error", message: "x".repeat(501), path: "/" })).status).toBe(400);
  expect(lines()).toEqual([]);
});
