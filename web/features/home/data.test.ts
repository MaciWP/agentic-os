import { expect, test } from "bun:test";
import { agentsSource } from "./data.ts";

const settled = { isError: false, isPending: false, error: null, refetch: () => {} };

test("agents stay loading until both the terminals and the agent scan arrive", () => {
  const terminals = settled;
  expect(agentsSource(terminals, { ...settled, isPending: true, data: undefined })).toEqual({
    state: "loading",
  });
  expect(agentsSource(terminals, { ...settled, data: { missing: [] } })).toEqual({ state: "ok" });
  expect(
    agentsSource({ ...settled, isPending: true }, { ...settled, data: { missing: [] } }),
  ).toEqual({ state: "loading" });
});
