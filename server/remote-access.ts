import type { MiddlewareHandler } from "hono";
import type { RemoteConfig } from "../shared/access.ts";

const remote = new WeakSet<Request>();
export const isRemoteRequest = (req: Request) => remote.has(req);

// Used ONLY on the separate loopback ingress. Tailscale Serve strips client identity
// headers before adding its own. Local processes retain the existing same-user trust.
export function remoteGuard(config: RemoteConfig): MiddlewareHandler {
  const origin = config.origin ? new URL(config.origin).origin : "";
  const host = origin ? new URL(origin).host : "";
  return async (c, next) => {
    if (!config.enabled || !origin || !config.login)
      return c.json({ error: "remote_disabled" }, 403);
    if (
      c.req.header("host") !== host ||
      c.req.header("tailscale-user-login") !== config.login ||
      c.req.header("tailscale-funnel-request")
    )
      return c.json({ error: "remote_unauthorized" }, 403);
    const sentOrigin = c.req.header("origin");
    const socket = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const write = ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method);
    if ((socket || write || sentOrigin !== undefined) && sentOrigin !== origin)
      return c.json({ error: "forbidden_origin" }, 403);
    remote.add(c.req.raw);
    await next();
  };
}
