import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";

// The page loads only its own files, so an injected script (which could type into a terminal
// through /send) never runs. blob: is the voice AudioWorklet (web/features/voice/capture.ts);
// inline styles are React style props, xterm and Radix. No other site may frame the app and
// steer a click onto one of its one-click actions. e2e/csp.e2e.ts visits every route under it.
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The built SPA. Vite names every file under /assets by its content hash, so a browser keeps
// them for good; index.html is checked on each load, so a `bun run refresh` reaches open
// devices. Compressed here, and /api's JSON in app.ts (its SSE and WebSockets stay as they
// are). A remote device on mobile data downloads about a third of the bytes. A chunk missing after a rebuild is a 404,
// never index.html kept for a year as a script.
export function staticApp(root: string) {
  return new Hono()
    .use("/*", async (c, next) => {
      await next();
      c.header("Content-Security-Policy", CSP);
      c.header("X-Frame-Options", "DENY");
    })
    .use("/*", compress())
    .use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    })
    .use("/assets/*", serveStatic({ root }))
    .all("/assets/*", (c) => c.text("Not found", 404))
    .use("/*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-cache");
    })
    .use("/*", serveStatic({ root }))
    .get("/*", serveStatic({ root, path: "index.html" }));
}

// What each server port serves: the API, a JSON 404 for any other /api path, then the SPA.
export function withSpa(api: Parameters<Hono["route"]>[1], root: string) {
  return new Hono()
    .route("/", api)
    .all("/api/*", (c) => c.json({ error: "not_found" }, 404))
    .route("/", staticApp(root));
}
