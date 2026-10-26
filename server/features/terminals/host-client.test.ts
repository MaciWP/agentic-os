import { afterAll, describe, expect, test } from "bun:test";
import { PROTOCOL } from "../../../shared/host-contract.ts";
import { HostClient } from "./host-client.ts";

// A host that answers every route with this body, whatever the shape the route promises.
let body: unknown = [];
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => Response.json(body),
});
const client = new HostClient(
  async () => ({ port: fake.port ?? 0, token: "t".repeat(43), pid: 1, protocol: PROTOCOL }),
  async () => ({}),
);
afterAll(() => {
  client.close();
  fake.stop(true);
});

describe("HostClient replies", () => {
  test("a reply that does not match its schema is an error, never data", async () => {
    body = [{ id: 1 }];
    await expect(client.list()).rejects.toThrow("PTY host GET /terminals: malformed reply");
    body = { text: "x", seq: "1", state: "running" };
    await expect(client.read("a")).rejects.toThrow("malformed reply");
    body = "yes";
    await expect(client.stop("a")).rejects.toThrow("malformed reply");
  });

  test("a well-formed reply passes through", async () => {
    body = { text: "hi", seq: 2, state: "running" };
    expect(await client.read("a")).toEqual({ text: "hi", seq: 2, state: "running" });
    body = [3, 4];
    expect(await client.pids()).toEqual(new Set([3, 4]));
  });
});
