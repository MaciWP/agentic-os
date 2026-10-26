import type { MiddlewareHandler } from "hono";
import { isRemoteRequest } from "./remote-access.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The app's own name. Browsers resolve every *.localhost to the loopback without asking DNS
// (RFC 6761), so it cannot be rebound to another machine; it is matched exactly, never as a
// suffix.
export const APP_HOST = "agentic-os.localhost";
export const LOCAL_NAMES = ["localhost", "127.0.0.1", APP_HOST] as const;

// The Vite dev port is ours only while developing; in production another local server may own it.
export const servedPorts = (port: number, devPort: number, production: boolean) =>
  production ? [port] : [port, devPort];

// Blocks DNS rebinding (Host), cross-site writes (Origin) and form posts (JSON Content-Type).
// The remote name is accepted only on a request the remote ingress authenticated: reaching
// this port directly with that Host and Origin proves no identity.
export function localGuard(ports: number[], remoteOrigin?: string): MiddlewareHandler {
  const hosts = new Set(ports.flatMap((p) => LOCAL_NAMES.map((name) => `${name}:${p}`)));
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const remote = remoteOrigin ? new URL(remoteOrigin) : undefined;
  return async (c, next) => {
    const viaIngress = remote !== undefined && isRemoteRequest(c.req.raw);
    const host = c.req.header("host") ?? "";
    if (!hosts.has(host) && !(viaIngress && host === remote.host)) {
      return c.json({ error: "forbidden_host" }, 403);
    }
    if (MUTATING.has(c.req.method)) {
      const origin = c.req.header("origin") ?? "";
      if (!origins.has(origin) && !(viaIngress && origin === remote.origin)) {
        return c.json({ error: "forbidden_origin" }, 403);
      }
      const type = c.req.header("content-type") ?? "";
      if (!type.toLowerCase().startsWith("application/json")) {
        return c.json({ error: "json_required" }, 415);
      }
    }
    await next();
  };
}
