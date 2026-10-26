import type { MiddlewareHandler } from "hono";
import type { Config } from "../../config.ts";
import { LOCAL_NAMES, servedPorts } from "../../local-guard.ts";
import { isRemoteRequest } from "../../remote-access.ts";

export const TOKEN_TTL_MS = 30_000;

// Browsers do not apply CORS to WebSockets, so any page could open one to localhost.
// The upgrade needs an exact Host and an exact Origin; a missing or "null" Origin fails.
export function allowedOrigins(
  port: number,
  devPort: number,
  production: boolean,
  remoteOrigin?: string,
): Set<string> {
  return new Set([
    ...servedPorts(port, devPort, production).flatMap((p) =>
      LOCAL_NAMES.map((name) => `http://${name}:${p}`),
    ),
    ...(remoteOrigin ? [new URL(remoteOrigin).origin] : []),
  ]);
}

// The origins this server's own pages load from.
export const configOrigins = (config: Config) =>
  allowedOrigins(
    config.port,
    config.devPort,
    process.env.NODE_ENV === "production",
    config.remote.enabled ? config.remote.origin : undefined,
  );

// A local name passes on its own; the remote one only on a socket the ingress authenticated,
// the same mark local-guard.ts checks: reaching this port with that Host and Origin proves
// no identity.
export function wsGuard(origins: Set<string>): MiddlewareHandler {
  const local = new Set<string>();
  const remote = new Set<string>();
  for (const o of origins) {
    const url = new URL(o);
    const names = (LOCAL_NAMES as readonly string[]).includes(url.hostname) ? local : remote;
    names.add(url.host).add(url.origin);
  }
  return async (c, next) => {
    const allowed = isRemoteRequest(c.req.raw) ? remote : local;
    if (!allowed.has(c.req.header("host") ?? "")) return c.json({ error: "forbidden_host" }, 403);
    if (!allowed.has(c.req.header("origin") ?? "")) {
      return c.json({ error: "forbidden_origin" }, 403);
    }
    await next();
  };
}

type Grant = { terminalId: string; origin: string; expires: number };

// One-use attach tokens: issued by a guarded POST, sent as the first WS message.
// They live only in memory, so a server restart invalidates all of them.
export class AttachTokens {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(terminalId: string, origin: string): string {
    this.sweep();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.grants.set(token, { terminalId, origin, expires: this.now() + TOKEN_TTL_MS });
    return token;
  }

  // Deleted before it is checked: a replay, even a concurrent one, finds nothing.
  consume(token: string, terminalId: string, origin: string): boolean {
    const grant = this.grants.get(token);
    this.grants.delete(token);
    return (
      grant !== undefined &&
      grant.expires > this.now() &&
      grant.terminalId === terminalId &&
      grant.origin === origin
    );
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token);
  }
}
