import { Hono } from "hono";
import { z } from "zod";
import type { MachineConfig } from "../../../shared/access.ts";
import { type CoordMessage, MessageRecord } from "../../../shared/coordination.ts";
import { errorMessage } from "../../error-message.ts";
import { paired } from "../system/update.ts";
import type { Messenger, Outcome } from "./messages.ts";
import type { CoordinationStore } from "./store.ts";

// Messages between machines, as mail: each machine keeps its own threads, and an address
// `agent@machine` names an agent elsewhere. The hub opens every connection, with the worker's
// pairing token: it hands its messages to the worker's inbound route and collects the
// worker's from its outbox. So the worker holds no secret, and a sender's machine is the one
// the hub talked to, never what the sender claims. On a worker, the hub is `@hub`.
// ponytail: the hub polls each outbox every POLL_MS; hold the request open on the worker if
// replies ever need to land faster.

export const HUB = "hub";
export const POLL_MS = 3_000;
const SEND_MS = 30_000;

// A message as it crosses: `to` and `from` are bare agent ids on their own machine, `id` is
// the sender's, and `replyTo` already names the receiver's own message.
export const Wire = z.object({
  id: MessageRecord.shape.id,
  from: MessageRecord.shape.requestId,
  to: MessageRecord.shape.requestId,
  text: MessageRecord.shape.text,
  replyTo: MessageRecord.shape.id.optional(),
});
export type Wire = z.infer<typeof Wire>;
const Status = z.object({ status: MessageRecord.shape.status, error: z.string().nullable() });

export const splitAddress = (to: string) => {
  const at = to.indexOf("@");
  return at < 0 ? null : { agent: to.slice(0, at), machine: to.slice(at + 1) };
};

// A message bound for another machine, as that machine reads it. A reply names the message it
// answers by that machine's id, which the received copy kept as its request id.
export function toWire(store: CoordinationStore, m: CoordMessage): Wire {
  const to = splitAddress(m.to)?.agent ?? m.to;
  const replyTo = m.replyTo ? store.getMessage(m.replyTo).requestId : undefined;
  return { id: m.id, from: m.from, to, text: m.text, ...(replyTo && { replyTo }) };
}

// A message from `machine` lands in this store, keyed on the sender's id so a resend never
// types twice, and goes to its recipient like a local one.
export async function receive(
  store: CoordinationStore,
  messenger: Messenger,
  machine: string,
  w: Wire,
): Promise<Outcome> {
  const m = store.message(`${w.from}@${machine}`, {
    requestId: w.id,
    to: w.to,
    text: w.text,
    ...(w.replyTo && { replyTo: w.replyTo }),
  });
  await messenger.deliver(m.id);
  const { status, error } = store.getMessage(m.id);
  return { status, error };
}

// A worker's own messages to `agent@hub` wait in its outbox; it reaches no other machine.
export const workerRemote = {
  held: (to: string) => splitAddress(to)?.machine === HUB,
  relay: async (m: CoordMessage): Promise<Outcome> => ({
    status: "failed",
    error: `un worker solo escribe a @${HUB}, no a ${m.to}`,
  }),
};

// The worker's side: what the hub hands in and what it collects, both behind the token.
export function workerMessageRoutes(deps: {
  store: CoordinationStore;
  messenger: Messenger;
  // A worker's data folder, where its pairing is; none on a hub, which answers 401 to everyone.
  dataDir: string | undefined;
}) {
  const { store, messenger, dataDir } = deps;
  const outbox = () =>
    store.messages().filter((m) => m.status === "pending" && splitAddress(m.to)?.machine === HUB);
  return new Hono()
    .use(async (c, next) => {
      if (!dataDir || !paired(dataDir, c.req.header("authorization")))
        return c.json({ error: "unpaired" }, 401);
      await next();
    })
    .post("/inbound", async (c) => {
      const w = Wire.safeParse(await c.req.json().catch(() => null));
      if (!w.success) return c.json({ error: "bad_request", detail: w.error.message }, 400);
      return c.json(await receive(store, messenger, HUB, w.data));
    })
    .get("/outbox", (c) => c.json({ messages: outbox().map((m) => toWire(store, m)) }))
    .post("/outbox/:id", async (c) => {
      const done = Status.safeParse(await c.req.json().catch(() => null));
      if (!done.success) return c.json({ error: "bad_request", detail: done.error.message }, 400);
      const m = store.getMessage(c.req.param("id"));
      if (splitAddress(m.to)?.machine !== HUB) return c.json({ error: "not_found" }, 404);
      // The hub's copy says how delivery went; only the hub settles what it collected.
      store.updateMessage(
        m.id,
        done.data.status === "pending" ? "uncertain" : done.data.status,
        done.data.error,
      );
      return c.json(store.getMessage(m.id));
    });
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Tokens = { get: (id: string) => Promise<string | null> };

// The hub's side: one door per worker, both ways.
export function hubMessages(deps: {
  machines: MachineConfig[];
  tokens: Tokens;
  store: CoordinationStore;
  get?: Fetch;
}) {
  const { machines, tokens, store, get = fetch } = deps;
  const call = async (machine: MachineConfig, path: string, body?: unknown) => {
    const token = await tokens.get(machine.id);
    if (!token) throw new Error(`${machine.label} no está emparejado`);
    const res = await get(new URL(`/api/coordination/remote${path}`, machine.origin).href, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: new URL(machine.origin).origin,
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_MS),
    });
    if (!res.ok) throw new Error(`${machine.label}: HTTP ${res.status}`);
    return res.json();
  };
  return {
    // Hands one message to its machine; the worker answers with how its delivery went.
    async relay(m: CoordMessage): Promise<Outcome> {
      const address = splitAddress(m.to);
      const machine = machines.find((x) => x.id === address?.machine);
      if (!machine)
        return { status: "failed", error: `no hay ninguna máquina «${address?.machine}»` };
      try {
        return Status.parse(await call(machine, "/inbound", toWire(store, m)));
      } catch (err) {
        // It may have arrived: the worker keys on this id, so a resend would not type twice.
        return { status: "uncertain", error: errorMessage(err) };
      }
    },
    // Collects what each worker's agents sent here, delivers it, and tells the worker.
    async collect(messenger: Messenger) {
      for (const machine of machines) {
        if (!(await tokens.get(machine.id))) continue;
        const { messages } = z
          .object({ messages: z.array(Wire) })
          .parse(await call(machine, "/outbox"));
        for (const w of messages) {
          let outcome: Outcome;
          try {
            outcome = await receive(store, messenger, machine.id, w);
          } catch (err) {
            outcome = { status: "failed", error: errorMessage(err) };
          }
          await call(machine, `/outbox/${encodeURIComponent(w.id)}`, outcome);
        }
      }
    },
  };
}
