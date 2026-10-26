// The page's CSP has no 'unsafe-eval' (server/static.ts). zod decides when each z.object is
// built, at import, whether to compile validators, and probes `Function("")` to find out; the
// browser logs that as a violation. A classic script runs before every module, so zod finds this
// already set. `__zod_globalConfig` is zod's own name (zod/v4/core/core.js); if a zod update
// renames it, e2e/csp.e2e.ts fails on the probe again.
globalThis.__zod_globalConfig = { jitless: true };
