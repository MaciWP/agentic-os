import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { App } from "./app.tsx";
import { watchErrors } from "./report.ts";
import { storageKey } from "./storage.ts";
import "@fontsource-variable/ibm-plex-sans";
import "./tokens.css";

// `bun run refresh` replaces the hashed chunks, so a tab open on the old build fails its next
// lazy import. Reload once to pick up the new index; a chunk still missing 10 s later is a real
// error and is left to show.
const lastChunkReload = storageKey("aos.chunk-reload", {
  schema: z.string(),
  fallback: "0",
  area: "session",
});
window.addEventListener("vite:preloadError", (event) => {
  if (Date.now() - Number(lastChunkReload.get()) < 10_000) return;
  if (!lastChunkReload.set(String(Date.now()))) return;
  event.preventDefault();
  location.reload();
});

watchErrors(window);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
