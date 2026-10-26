import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import { newPairing } from "../system/update.ts";
import { Messenger, type Remote } from "./messages.ts";
import { HUB, hubMessages, receive, workerMessageRoutes, workerRemote } from "./remote.ts";
import { CoordinationStore } from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-remote-"));
afterAll(() => rmSync(dir, { recursive: true }));

// One machine's coordination: its store, the text its agents got, and its messenger.
function machine(agents: string[], remote: () => Remote) {
  const store = new CoordinationStore(openDb(":memory:"));
  const typed: string[] = [];
  const messenger = new Messenger(
    store,
    {
      get: async (id) =>
        agents.includes(id) ? { state: "running", harness: "claude" } : undefined,
      write: async (id, data) => {
        if (data !== "\r") typed.push(`${id}: ${data}`);
        return true;
      },
    },
    0,
    { held: (to) => remote().held(to), relay: (m) => remote().relay(m) },
  );
  return { store, typed, messenger };
}

// The Mac drives the PC: the hub's calls reach the worker's routes in process.
const token = await newPairing(dir);
const pc = machine(["b2", "c3"], () => workerRemote);
const routes = workerMessageRoutes({ store: pc.store, messenger: pc.messenger, dataDir: dir });
const mac = machine(["a1"], () => ({ held: () => false, relay: hub.relay }));
const hub = hubMessages({
  machines: [{ id: "win", label: "PC", origin: "https://pc.example.ts.net" }],
  tokens: { get: async () => token },
  store: mac.store,
  get: async (url, init) =>
    routes.request(new URL(url).pathname.replace("/api/coordination/remote", ""), init),
});

test("a Mac agent writes to a PC agent, the reply comes back and answers the thread", async () => {
  const sent = mac.store.message("a1", { requestId: "r1", to: "b2@win", text: "¿compila?" });
  await mac.messenger.deliver(sent.id);
  expect(mac.store.getMessage(sent.id).status).toBe("delivered");
  expect(pc.typed).toHaveLength(1);
  expect(pc.typed[0]).toContain(`from a1@${HUB}`);
  expect(pc.typed[0]).toContain("¿compila?");

  // The PC's copy has its own id; the reply names it, and the Mac sees its own message answered.
  const copy = pc.store.messages().find((m) => m.from === `a1@${HUB}`);
  if (!copy) throw new Error("no copy on the PC");
  expect(copy.id).not.toBe(sent.id);
  const reply = pc.store.message("b2", {
    requestId: "r2",
    to: `a1@${HUB}`,
    text: "sí",
    replyTo: copy.id,
  });
  await pc.messenger.deliver(reply.id);
  expect(pc.store.getMessage(reply.id).status).toBe("pending");
  await hub.collect(mac.messenger);
  expect(mac.typed).toHaveLength(1);
  expect(mac.typed[0]).toContain("from b2@win");
  expect(mac.store.getMessage(sent.id).status).toBe("answered");
  expect(pc.store.getMessage(reply.id).status).toBe("delivered");
  expect(pc.store.getMessage(copy.id).status).toBe("answered");

  // Collected once: a second round and a resend type nothing again.
  await hub.collect(mac.messenger);
  expect(await hub.relay(mac.store.getMessage(sent.id))).toEqual({
    status: "answered",
    error: null,
  });
  expect([mac.typed.length, pc.typed.length]).toEqual([1, 1]);
});

test("only the recipient answers a thread, across machines too", async () => {
  const sent = mac.store.message("a1", { requestId: "r3", to: "b2@win", text: "hola" });
  await mac.messenger.deliver(sent.id);
  const copy = pc.store.messages().find((m) => m.requestId === sent.id);
  if (!copy) throw new Error("no copy on the PC");
  // c3 was not the one asked.
  expect(() =>
    pc.store.message("c3", { requestId: "r4", to: `a1@${HUB}`, text: "yo", replyTo: copy.id }),
  ).toThrow("reply_owner");
  // Nor can the PC answer on the Mac for a message sent to someone else.
  await expect(
    receive(mac.store, mac.messenger, "win", {
      id: "x1",
      from: "c3",
      to: "a1",
      text: "yo",
      replyTo: sent.id,
    }),
  ).rejects.toThrow("reply_owner");
});

test("without the pairing token the worker's door stays shut", async () => {
  const res = await routes.request("/outbox");
  expect(res.status).toBe(401);
  const wrong = await routes.request("/inbound", {
    method: "POST",
    headers: { authorization: "Bearer nope", "content-type": "application/json" },
    body: "{}",
  });
  expect(wrong.status).toBe(401);
});

test("a worker writes only to the hub; the hub only to machines it knows", async () => {
  const lost = mac.store.message("a1", { requestId: "r5", to: "b2@laptop", text: "hola" });
  await mac.messenger.deliver(lost.id);
  expect(mac.store.getMessage(lost.id)).toMatchObject({ status: "failed" });
  const sideways = pc.store.message("b2", { requestId: "r6", to: "z@laptop", text: "hola" });
  await pc.messenger.deliver(sideways.id);
  expect(pc.store.getMessage(sideways.id).status).toBe("failed");
});
