import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import type { MachineConfig } from "../shared/access.ts";
import { PROXY_WRITE_MS } from "../shared/machines.ts";
import { errorMessage } from "./error-message.ts";
import { wsGuard } from "./features/terminals/ws-guard.ts";
import { log } from "./log.ts";
import type { PeerState } from "./tailscale.ts";

// The hub's door to its workers: `/api/machines/<id>/<rest>` is the worker's `/api/<rest>`,
// sent to its remote ingress with the worker's own Origin. The worker's guards, route
// allowlist and attach tokens run there unchanged; ids and bodies pass through untouched.

// Request headers worth sending on; the rest (cookies, the browser's Origin) stay here.
const FORWARD = ["content-type", "accept", "last-event-id", "if-none-match"];
// Fetch has already decoded the body and a proxy sets its own framing.
export const DROP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);
// Until the worker's headers arrive. A stream (events) has none once it answered.
const READ_MS = 10_000;
const HEALTH_MS = 2_000;
export const AI_WAIT_MS = 600_000;
// Frames a browser may send before the worker's socket opens: the token and a resize.
const MAX_QUEUED = 64;
// A worker socket not open by then is given up with 4503, so the window's own backoff retries
// instead of waiting out the system's TCP timeout.
const OPEN_MS = 10_000;

export type MachineStatus = MachineConfig & {
  online: boolean;
  ms: number | null;
  error: string | null;
  // The code version the worker last received from this hub; null before its first update.
  version: string | null;
  // What this hub's Tailscale says of it, read only when it does not answer.
  tailscale: PeerState | null;
};

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type MachineOptions = {
  get?: Fetch;
  // The hub's own code, for «Actualizar»: its version and the bundle a worker unpacks.
  code?: { version: () => Promise<string>; bundle: () => Promise<Uint8Array> };
  // Each worker's pairing token, kept in the Keychain.
  tokens?: {
    get: (id: string) => Promise<string | null>;
    set: (id: string, token: string) => Promise<void>;
  };
  // This hub's Tailscale view of a peer, by its name; null when Tailscale cannot say.
  peer?: (host: string) => Promise<PeerState | null>;
  openMs?: number;
  health?: Breaker;
};

// What `bun scripts/pair.ts` prints on the worker: 32 random bytes, base64url.
export const TokenBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
// Unpacking and checking a whole bundle: longer than any proxied write.
const UPDATE_MS = 6 * 60_000;

// A worker's path for a hub path, or null when it would leave the worker's /api.
export function upstreamUrl(machine: MachineConfig, rest: string, search: string): URL | null {
  if (!rest.startsWith("/")) return null;
  const url = new URL(`/api${rest}${search}`, machine.origin);
  return url.origin === new URL(machine.origin).origin && url.pathname.startsWith("/api/")
    ? url
    : null;
}

// A socket close code a server may send on: the worker's own, else 4503 so the window retries.
export const relayCode = (code: number) =>
  code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 4503;

// Why a worker is offline, as what to do about it. Tailscale Serve answers 502 when the server
// behind it is down: after a reboot that is a machine waiting for a login, since Tailscale runs
// unattended and the worker starts at logon. No answer at all is told apart by this hub's Tailscale: the machine is off
// the tailnet, or it is on and publishes no Serve route.
export function offlineReason(
  status: number | null,
  detail: string,
  peer: PeerState | null = null,
): string {
  if (status === 502)
    return "Tailscale Serve responde, pero su servidor no: si acaba de arrancar, espera inicio de sesión (el worker arranca al entrar); si no, pulsa «Agentic OS» en ella";
  if (status !== null) return `HTTP ${status}`;
  if (peer && !peer.online) {
    const seen = peer.lastSeen
      ? ` (vista por última vez el ${new Date(peer.lastSeen).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})`
      : "";
    return `apagada o fuera de Tailscale${seen}: enciéndela; el worker arranca al iniciar sesión`;
  }
  if (peer?.online)
    return "Tailscale la ve encendida, pero no publica su ruta Serve: vuelve sola en un minuto; si no, pulsa «Agentic OS» en ella";
  return `sin respuesta (${detail}): la máquina está apagada o no publica Tailscale Serve; arranca el worker en ella`;
}

async function probe(
  machine: MachineConfig,
  get: Fetch,
  peer: MachineOptions["peer"],
): Promise<MachineStatus> {
  const started = performance.now();
  const down = async (ms: number | null, status: number | null, detail: string) => {
    const tailscale =
      status === null && peer
        ? await peer(new URL(machine.origin).hostname).catch(() => null)
        : null;
    return {
      ...machine,
      online: false,
      ms,
      error: offlineReason(status, detail, tailscale),
      version: null,
      tailscale,
    };
  };
  try {
    const res = await get(new URL("/api/health", machine.origin).href, {
      signal: AbortSignal.timeout(HEALTH_MS),
    });
    const ms = Math.round(performance.now() - started);
    if (!res.ok) return down(ms, res.status, "");
    const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
    const version = typeof body?.version === "string" ? body.version : null;
    return { ...machine, online: true, ms, error: null, version, tailscale: null };
  } catch (err) {
    return down(null, null, errorMessage(err));
  }
}

// A worker that did not answer is not asked again until `until`: each tab polls it every few
// seconds, and every try held a request for up to READ_MS. The wait doubles up to DOWN_MAX_MS;
// the first request after it is the only one let through, once the worker's health answers.
const DOWN_FIRST_MS = 2_000;
const DOWN_MAX_MS = 30_000;
type Down = { until: number; wait: number; reason: string };

export type Breaker = {
  // A 503 to answer at once while the machine is held down, "try" for the one let through
  // after the wait, else null.
  hold: (c: Context, machine: MachineConfig) => Response | "try" | null;
  failed: (machine: MachineConfig, reason: string) => void;
  answered: (machine: MachineConfig) => void;
};

export function breaker(now: () => number = Date.now): Breaker {
  const down = new Map<string, Down>();
  return {
    hold(c, machine) {
      const d = down.get(machine.id);
      if (!d) return null;
      const left = d.until - now();
      if (left <= 0) {
        // Let this one try; the rest wait for its answer.
        d.until = now() + d.wait;
        return "try";
      }
      c.header("retry-after", String(Math.ceil(left / 1000)));
      return c.json(
        { error: "machine_offline", detail: `${machine.label} no responde: ${d.reason}` },
        503,
      );
    },
    failed(machine, reason) {
      const d = down.get(machine.id);
      const wait = d ? Math.min(d.wait * 2, DOWN_MAX_MS) : DOWN_FIRST_MS;
      if (!d) log("machines").warn(`${machine.label} down`, { machine: machine.id, reason });
      down.set(machine.id, { until: now() + wait, wait, reason });
    },
    answered(machine) {
      if (down.delete(machine.id))
        log("machines").info(`${machine.label} up`, { machine: machine.id });
    },
  };
}

async function proxy(
  c: Context,
  machine: MachineConfig,
  get: Fetch,
  health: Breaker,
): Promise<Response> {
  const prefix = `/api/machines/${machine.id}`;
  const url = upstreamUrl(machine, c.req.path.slice(prefix.length), new URL(c.req.url).search);
  if (!url) return c.json({ error: "bad_request", detail: "ruta fuera de la API" }, 400);
  let held = health.hold(c, machine);
  // The try asks the worker's health first, which answers within HEALTH_MS: a machine on but
  // silent held the request, and a browser connection, for all of READ_MS at every try.
  if (held === "try") {
    const status = await probe(machine, get, undefined);
    if (!status.online) {
      health.failed(machine, status.error ?? "sin respuesta");
      held = health.hold(c, machine);
    }
  }
  if (held instanceof Response) return held;
  const headers = new Headers({ origin: new URL(machine.origin).origin });
  for (const name of FORWARD) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const read = c.req.method === "GET";
  const deadline = new AbortController();
  // The local model answers a queued request only when its one slot frees: headers can take
  // minutes, as long as Claude Code itself waits (API_TIMEOUT_MS in its terminal env).
  const waitMs = read
    ? READ_MS
    : url.pathname.startsWith("/api/ai/v1/")
      ? AI_WAIT_MS
      : PROXY_WRITE_MS;
  const timer = setTimeout(() => deadline.abort(), waitMs);
  try {
    const res = await get(url.href, {
      method: c.req.method,
      headers,
      body: read ? undefined : await c.req.arrayBuffer(),
      // The browser leaving ends the worker's request too (a stream, a slow git call).
      signal: AbortSignal.any([c.req.raw.signal, deadline.signal]),
    });
    // Every answer of the worker's own server carries its request ID; a 50x without one is
    // Tailscale Serve saying the server behind it is down.
    if (res.status >= 502 && res.status <= 504 && !res.headers.has("x-request-id")) {
      await res.body?.cancel();
      const detail = offlineReason(res.status, "");
      health.failed(machine, detail);
      return c.json({ error: "machine_unreachable", detail: `${machine.label}: ${detail}` }, 502);
    }
    health.answered(machine);
    const out = new Headers();
    res.headers.forEach((value, name) => {
      if (!DROP.has(name)) out.set(name, value);
    });
    return new Response(res.body, { status: res.status, headers: out });
  } catch (err) {
    const late = deadline.signal.aborted;
    // A tab that left is no sign of the worker, nor is a slow write (git, the model's queue).
    if (!c.req.raw.signal.aborted && (read || !late))
      health.failed(machine, late ? "timeout" : errorMessage(err));
    return c.json(
      {
        error: late ? "machine_timeout" : "machine_unreachable",
        detail: late
          ? `${machine.label} no ha respondido a tiempo.`
          : `${machine.label} no responde: ${errorMessage(err)}`,
      },
      late ? 504 : 502,
    );
  } finally {
    clearTimeout(timer);
  }
}

// The hub sends its code to a worker with that worker's token, and relays the answer.
async function sendUpdate(
  c: Context,
  machine: MachineConfig,
  code: NonNullable<MachineOptions["code"]>,
  token: string,
  get: Fetch,
): Promise<Response> {
  const version = await code.version();
  const bundle = Buffer.from(await code.bundle()).toString("base64");
  try {
    const res = await get(new URL("/api/system/update", machine.origin).href, {
      method: "POST",
      headers: {
        origin: new URL(machine.origin).origin,
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ version, bundle }),
      // Not the browser's signal: a tab closed mid-update must not cut the worker's copy.
      signal: AbortSignal.timeout(UPDATE_MS),
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    return c.json(
      {
        error: "machine_unreachable",
        detail: `${machine.label} no responde: ${errorMessage(err)}`,
      },
      502,
    );
  }
}

export function machineRoutes(
  machines: MachineConfig[],
  origins: Set<string>,
  { get = fetch, code, tokens, peer, openMs = OPEN_MS, health = breaker() }: MachineOptions = {},
) {
  const find = (id: string | undefined) => machines.find((m) => m.id === id);
  const forward = async (c: Context): Promise<Response> => {
    const machine = find(c.req.param("machine"));
    if (!machine) return c.json({ error: "unknown_machine" }, 404);
    return proxy(c, machine, get, health);
  };
  return (
    new Hono()
      .get("/", async (c) =>
        c.json({
          machines: await Promise.all(machines.map((m) => probe(m, get, peer))),
          version: (await code?.version()) ?? null,
        }),
      )
      // Registered before the catch-alls: the hub's own routes for a worker.
      .post("/:machine/update", async (c) => {
        const machine = find(c.req.param("machine"));
        if (!machine) return c.json({ error: "unknown_machine" }, 404);
        const token = await tokens?.get(machine.id);
        if (!code || !token)
          return c.json(
            {
              error: "unpaired",
              detail: `${machine.label} no está emparejado: ejecuta \`bun scripts/pair.ts\` en él y pega aquí su token.`,
            },
            409,
          );
        return sendUpdate(c, machine, code, token, get);
      })
      .put("/:machine/token", async (c) => {
        const machine = find(c.req.param("machine"));
        if (!machine) return c.json({ error: "unknown_machine" }, 404);
        const body = TokenBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: "token no válido" }, 400);
        if (!tokens) return c.json({ error: "unavailable" }, 409);
        await tokens.set(machine.id, body.data.token);
        return c.json({ paired: machine.id });
      })
      // Registered before the catch-all: a terminal's socket, bridged to the worker's. The token
      // the browser sends first was issued by the worker for its own Origin, which is the one
      // this bridge presents.
      .get(
        "/:machine/terminals/:id/ws",
        wsGuard(origins),
        upgradeWebSocket((c) => {
          const machine = find(c.req.param("machine"));
          const id = encodeURIComponent(c.req.param("id") ?? "");
          let up: WebSocket | undefined;
          let opening: ReturnType<typeof setTimeout> | undefined;
          const queued: (string | ArrayBuffer)[] = [];
          return {
            onOpen(_event, ws) {
              if (!machine) {
                ws.close(4404, "unknown machine");
                return;
              }
              const target = new URL(`/api/terminals/${id}/ws`, machine.origin);
              target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
              up = new WebSocket(target.href, {
                headers: { origin: new URL(machine.origin).origin },
              } as unknown as string[]);
              up.binaryType = "arraybuffer";
              opening = setTimeout(() => {
                if (!up) return;
                up.onclose = null;
                up.close();
                ws.close(4503, "worker not reachable");
              }, openMs);
              up.onopen = () => {
                clearTimeout(opening);
                for (const frame of queued.splice(0)) up?.send(frame);
              };
              up.onmessage = (event) => ws.send(event.data as string | ArrayBuffer);
              up.onclose = (event) => {
                clearTimeout(opening);
                ws.close(relayCode(event.code), event.reason);
              };
            },
            onMessage(event, ws) {
              const data = event.data as string | ArrayBuffer;
              if (up?.readyState === WebSocket.OPEN) up.send(data);
              else if (queued.length < MAX_QUEUED) queued.push(data);
              else ws.close(4503, "worker not ready");
            },
            onClose() {
              clearTimeout(opening);
              up?.close(1000, "window closed");
            },
          };
        }),
      )
      .get("/:machine/*", forward)
      .post("/:machine/*", forward)
      .put("/:machine/*", forward)
      .delete("/:machine/*", forward)
  );
}
