import { coded, type ErrorRule, rule } from "./errors.ts";
import { CoordinationError } from "./features/coordination/store.ts";
import { LaunchError } from "./launching.ts";
import { ProviderError } from "./provider-error.ts";

// The errors both processes raise, answered the same by each: the server's registry
// (app-errors.ts) and the host's, which host-client.ts reads back.
export const COMMON_ERRORS: readonly ErrorRule[] = [
  rule(CoordinationError, coded),
  rule(LaunchError, (e) => ({
    status: 400,
    body: { error: "launch_rejected", detail: e.message },
  })),
  rule(ProviderError, (e) => ({
    status: 502,
    body: { error: "provider_error", provider: e.provider, status: e.status, detail: e.message },
  })),
];
