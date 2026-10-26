import { expect, test } from "bun:test";
import { pollEvery } from "./poll.ts";

test("a failing read is polled slower until it answers again", () => {
  const every = pollEvery(3000);
  expect(every({ state: { status: "success" } })).toBe(3000);
  expect(every({ state: { status: "error" } })).toBe(18_000);
  expect(pollEvery(3000, 10)({ state: { status: "error" } })).toBe(30_000);
});
