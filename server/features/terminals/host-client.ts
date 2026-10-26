import { z } from "zod";
import {
  Accepted,
  CHANGED_FRAME,
  type CreateEnvRequest,
  ErrorReply,
  type HostFile,
  LaunchStatus,
  type RunEnvRequest,
  ScreenText,
  TerminalRecord,
  WaitResult,
} from "../../../shared/host-contract.ts";
import type { FoundHost } from "../../host/files.ts";
import { log } from "../../log.ts";
import { ProviderError } from "../../provider-error.ts";
import {
  type Client,
  dropIfSlow,
  type LaunchSpec,
  Listeners,
  MAX_WAIT_MS,
  type PasteMode,
  READ_LINES,
  type RestartResult,
  type TerminalInfo,
  type Terminals,
  type WaitOptions,
} from "./contract.ts";
import { LaunchError } from "./harness.ts";

const RestartReply: z.ZodType<RestartResult> = z.union([
  z.object({ terminal: TerminalRecord }),
  z.object({ refused: z.enum(["not_running", "no_session"]) }),
]);

// The PTY host cannot be reached or started. Routes answer 503; windows retry.
export class HostUnavailable extends Error {}

type Reply = { status: number; data: unknown };

// How long the host may take to answer. A create waits for the host's login environment
// (15 s at most) and, for an env, the provider's list (20 s); everything else is immediate.
const CALL_MS = 5_000;
const CREATE_MS = 45_000;

// The server's side of the PTY host: the same Terminals as the in-process manager, over
// loopback. Every call waits for the host, so the server never blocks its start on it.
export class HostClient implements Terminals {
  readonly consultations = {
    start: async (id: string) => {
      await this.call(Accepted, "POST", `/consultations/${encodeURIComponent(id)}/start`, {});
    },
    cancel: async (id: string) => {
      const url = `/consultations/${encodeURIComponent(id)}/cancel`;
      await this.call(Accepted, "POST", url, {}, 15_000);
    },
  };
  private link?: Promise<FoundHost>;
  private control?: WebSocket;
  // The host socket behind each attached window.
  private readonly sockets = new Map<Client, WebSocket>();
  private readonly listeners = new Listeners();

  constructor(
    // Finds the running host or starts one.
    private readonly connect: () => Promise<FoundHost>,
    // The server's own copy, for the env provider's list.
    private readonly loadEnv: () => Promise<Record<string, string>>,
  ) {}

  get env(): Promise<Record<string, string>> {
    return this.loadEnv();
  }

  // Connects now, so the host is up by the first request.
  warm(): void {
    this.ready().catch((err) => log("PTY host").error(err.message));
  }

  close(): void {
    this.control?.close();
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
  }

  // Hears the host's change notices, and its control socket opening (a new host) or
  // closing (the host went away): either way the list must be read again.
  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  async list(): Promise<TerminalInfo[]> {
    return found(await this.call(z.array(TerminalRecord), "GET", "/terminals"));
  }

  async pids(): Promise<Set<number>> {
    return new Set(found(await this.call(z.array(z.number()), "GET", "/pids")));
  }

  get(id: string): Promise<TerminalInfo | undefined> {
    return this.call(TerminalRecord, "GET", path(id));
  }

  async launchStatus(id: string): Promise<LaunchStatus | null> {
    const url = `/launches/${encodeURIComponent(id)}`;
    return found(await this.call(LaunchStatus.nullable(), "GET", url));
  }

  async create(spec: LaunchSpec): Promise<TerminalInfo> {
    return found(await this.call(TerminalRecord, "POST", "/terminals", spec, CREATE_MS));
  }

  async createEnv(req: CreateEnvRequest, size: { cols?: number; rows?: number } = {}) {
    return found(await this.call(TerminalRecord, "POST", "/envs", { req, size }, CREATE_MS));
  }

  async runEnv(req: RunEnvRequest, size: { cols?: number; rows?: number } = {}) {
    return found(await this.call(TerminalRecord, "POST", "/envs/run", { req, size }, CREATE_MS));
  }

  read(id: string, lines = READ_LINES): Promise<ScreenText | undefined> {
    return this.call(ScreenText, "GET", `${path(id)}/text?lines=${lines}`);
  }

  // 404: the terminal is gone, so nothing was written.
  async write(id: string, data: string, opts: { paste?: PasteMode } = {}): Promise<boolean> {
    return (await this.call(z.boolean(), "POST", `${path(id)}/input`, { data, ...opts })) ?? false;
  }

  // The host holds the request for the whole wait; the deadline leaves it room to answer.
  waitFor(id: string, opts: WaitOptions): Promise<WaitResult | undefined> {
    const ms = Math.min(opts.timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS) + 5_000;
    return this.call(WaitResult, "POST", `${path(id)}/wait`, opts, ms);
  }

  async stop(id: string): Promise<boolean> {
    return found(await this.call(z.boolean(), "POST", `${path(id)}/stop`));
  }

  async rename(id: string, name: string | null): Promise<boolean> {
    return found(await this.call(z.boolean(), "POST", `${path(id)}/name`, { name }));
  }

  resume(id: string): Promise<TerminalInfo | undefined> {
    return this.call(TerminalRecord, "POST", `${path(id)}/resume`, undefined, CREATE_MS);
  }

  restart(id: string): Promise<RestartResult | undefined> {
    return this.call(RestartReply, "POST", `${path(id)}/restart`, undefined, CREATE_MS);
  }

  async remove(id: string): Promise<boolean> {
    return found(await this.call(z.boolean(), "DELETE", path(id)));
  }

  // Pipes the host's socket to the window. The host applies takeover, overflow and 404 and
  // its close code reaches the window as is; the slow-window rule is applied here, against
  // the window's own buffer.
  async attach(id: string, client: Client, take = false): Promise<boolean> {
    const host = await this.ready();
    // The window may have closed while the host was coming up; a socket opened for it now
    // would hold the terminal for nobody, and every later attach would read as busy.
    if (!client.isOpen()) return true;
    const url = `ws://127.0.0.1:${host.port}/terminals/${encodeURIComponent(id)}/ws${take ? "?take=1" : ""}`;
    const ws = hostSocket(url, host);
    ws.binaryType = "arraybuffer";
    this.sockets.set(client, ws);
    let snapshotBytes = 0;
    ws.onmessage = (event) => {
      if (!client.isOpen()) {
        this.detach(id, client);
        return;
      }
      if (typeof event.data === "string") {
        if (event.data.startsWith('{"type":"snapshot"'))
          snapshotBytes = Buffer.byteLength(event.data);
        client.send(event.data);
      } else if (dropIfSlow(client, snapshotBytes)) {
        this.detach(id, client);
      } else if (event.data instanceof ArrayBuffer) {
        client.send(new Uint8Array(event.data));
      }
    };
    ws.onclose = (event) => {
      if (this.sockets.get(client) !== ws) return;
      this.sockets.delete(client);
      // Anything but the host's own codes means the host went away: 4503, the window retries.
      const own = event.code >= 4000 && event.code < 5000;
      if (client.isOpen())
        client.close(own ? event.code : 4503, own ? event.reason : "pty host unavailable");
    };
    return true;
  }

  detach(_id: string, client: Client): void {
    const ws = this.sockets.get(client);
    this.sockets.delete(client);
    ws?.close(1000, "detached");
  }

  input(_id: string, client: Client, data: string): void {
    this.send(client, { type: "input", data });
  }

  resize(_id: string, client: Client, cols: number, rows: number): void {
    this.send(client, { type: "resize", cols, rows });
  }

  private send(client: Client, msg: unknown): void {
    const ws = this.sockets.get(client);
    // The window sends its size right after attaching, before the host socket is open:
    // held until then, in order.
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else if (ws?.readyState === WebSocket.CONNECTING)
      ws.addEventListener("open", () => ws.send(JSON.stringify(msg)), { once: true });
  }

  // The host's pid while connected, and whether it runs older code; null before the first
  // connection or once it is gone. Never connects or starts a host by itself.
  async hostInfo(): Promise<{ pid: number; stale: boolean } | null> {
    return this.link
      ? this.link.then(
          (h) => ({ pid: h.pid, stale: h.stale === true }),
          () => null,
        )
      : null;
  }

  private ready(): Promise<FoundHost> {
    if (this.link) return this.link;
    const link: Promise<FoundHost> = this.connect().then(
      (host) => {
        this.watch(host, link);
        return host;
      },
      (err) => {
        if (this.link === link) this.link = undefined;
        throw err instanceof HostUnavailable ? err : new HostUnavailable(err.message);
      },
    );
    this.link = link;
    return link;
  }

  // The host is gone once its control socket closes; the next call finds or starts one.
  private watch(host: HostFile, link: Promise<FoundHost>): void {
    const ws = hostSocket(`ws://127.0.0.1:${host.port}/control`, host);
    this.control = ws;
    ws.onopen = () => this.listeners.notify();
    ws.onmessage = (event) => {
      if (event.data === CHANGED_FRAME) this.listeners.notify();
    };
    ws.onclose = () => {
      if (this.link === link) this.link = undefined;
      this.listeners.notify();
    };
  }

  // One host call: 404 answers undefined, any other success must match its schema. A reply
  // that does not is a host speaking another contract, never data to show.
  private async call<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = CALL_MS,
  ): Promise<T | undefined> {
    const reply = await this.request(method, path, body, timeoutMs);
    if (reply.status === 404) return undefined;
    const parsed = schema.safeParse(reply.data);
    if (parsed.success) return parsed.data;
    throw new Error(
      `PTY host ${method} ${path}: malformed reply: ${z.prettifyError(parsed.error)}`,
    );
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      const host = await this.ready();
      let res: Response;
      let data: unknown;
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        res = await fetch(`http://127.0.0.1:${host.port}${path}`, {
          signal,
          method,
          headers: {
            authorization: `Bearer ${host.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        data = await res.json().catch((err) => {
          if (signal.aborted) throw err;
          return {};
        });
      } catch (err) {
        // A slow host is still the host: its link and control socket stay. The request may
        // have been acted on, so it is not sent again.
        if (signal.aborted)
          throw new HostUnavailable(`PTY host did not answer within ${timeoutMs / 1000} s`);
        this.link = undefined;
        // Refused: the request never arrived, so it is safe to send once more to a new host.
        const refused = err instanceof Error && "code" in err && err.code === "ConnectionRefused";
        if (attempt === 0 && refused) continue;
        throw new HostUnavailable(`PTY host unreachable: ${String(err)}`);
      }
      if (res.ok || res.status === 404) return { status: res.status, data };
      if (res.status === 401) {
        this.link = undefined;
        throw new HostUnavailable("PTY host refused the token");
      }
      const parsed = ErrorReply.safeParse(data);
      const e = parsed.success ? parsed.data : {};
      const detail = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail ?? "");
      if (e.error === "launch_rejected")
        throw new LaunchError(e.detail === undefined ? "rejected" : detail);
      if (e.error === "provider_error")
        throw new ProviderError(e.provider ?? "pty-host", e.status ?? 502, detail);
      throw new Error(`PTY host ${method} ${path}: ${res.status} ${e.error ?? ""} ${detail}`);
    }
  }
}

// Bun's WebSocket takes headers. The options are checked against Bun's type; only the call
// is not, because the DOM lib the web build loads hides that overload.
function hostSocket(url: string, host: HostFile): WebSocket {
  const init: Bun.WebSocketOptions = { headers: { authorization: `Bearer ${host.token}` } };
  // @ts-expect-error Bun's constructor overload with options; see above.
  return new WebSocket(url, init);
}

// A 404 where the host never answers one: a host without the route.
function found<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("PTY host answered 404 for a route it serves");
  return value;
}

const path = (id: string) => `/terminals/${encodeURIComponent(id)}`;
