import { defineConfig } from "@playwright/test";

const baseURL = process.env.AOS_E2E_URL ?? "http://localhost:4317";

// Runs against the real server on the single origin; no fake binaries. Terminals draw with the
// DOM renderer, whose rows the tests read; terminal.e2e.ts checks the GPU one on its own.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  use: {
    baseURL,
    // A broken page fails each test at these, not at the 120 s test timeout: without them an
    // action waits for the whole test, and a bad build held the shared run for 20 minutes. The
    // action limit is also every API request's, and a host's first POST /api/terminals waits for
    // the login env, up to 45 s (LOGIN_ENV_TIMEOUT_MS, server/features/terminals/env.ts:67): 43 s
    // at load 11 overran a 20 s limit.
    actionTimeout: 60_000,
    navigationTimeout: 30_000,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(baseURL).origin,
          localStorage: [{ name: "aos.terminal-renderer", value: "dom" }],
        },
      ],
    },
  },
  reporter: "list",
  // One worker: every file shares the server's one workspace, so two files at once open the same
  // Mesa, take each other's terminals over ("Abierta en otra ventana") and reset each other's
  // Mesas; the readiness waits then fail with no defect behind them.
  workers: 1,
  // Room for waitReady (e2e/helpers.ts): 60 s for the shell's first output, then its drawing.
  timeout: 120_000,
  projects: [
    { name: "main", testIgnore: "**/events.e2e.ts" },
    // The events tests count every request a page makes, so they run alone, after the rest:
    // a terminal another test starts meanwhile would push a legitimate read.
    { name: "events", testMatch: "**/events.e2e.ts", dependencies: ["main"] },
  ],
});
