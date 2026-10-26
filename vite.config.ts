import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

import { DEV_API_PORT } from "./shared/runtime.ts";

const api = `http://127.0.0.1:${DEV_API_PORT}`;

// The proxy keeps the browser's side of a stream open when the server goes away, so the
// event stream would hang instead of reconnecting: end it with the server's side.
const toServer: ProxyOptions = {
  target: api,
  configure: (proxy) =>
    proxy.on("proxyRes", (proxyRes, _req, res) => {
      proxyRes.on("close", () => {
        if (!res.writableEnded) res.destroy();
      });
    }),
};

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  build: { outDir: "../dist", emptyOutDir: true },
  // Module workers split their dynamic imports: the highlight worker fetches each grammar it
  // needs instead of carrying all ~240 in one file.
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The terminal WebSocket goes through the same proxy; listed first so it matches first.
      // Trailing slashes: a bare "/api" would also send web/api.ts (/api.ts) to the server.
      "/api/terminals/": { target: api, ws: true },
      "/api/": toServer,
      "/auth/": api,
    },
  },
});
