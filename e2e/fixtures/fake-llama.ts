#!/usr/bin/env bun
// llama-server's stand-in for the isolated e2e (scripts/e2e-isolated.ts): the same argv, a
// /health that answers at once, and /v1/* echoing what reached it. No model, no GPU.
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname.startsWith("/v1/"))
      return Response.json({ path: url.pathname + url.search, body: await req.json() });
    return new Response("not found", { status: 404 });
  },
});
console.error(`fake engine on ${port}`);
