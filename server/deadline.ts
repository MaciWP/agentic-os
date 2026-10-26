// Bun.serve resets a request whose handler has sent nothing for `idleTimeout` seconds
// (10 by default). The longest route, a ticket launch in an env, can chain a Jira read
// (25 s) and a terminal create (45 s); both end well before this.
export const IDLE_TIMEOUT_S = 120;

type BunServer = { timeout?: (req: Request, seconds: number) => void };

// Lifts that timeout for one request that waits by design (an event stream, a dialog on the
// Mac). `env` is the Bun server Hono passes on; in tests it is absent and this does nothing.
export const holdOpen = (env: unknown, req: Request) =>
  (env as BunServer | undefined)?.timeout?.(req, 0);

// One deadline per operation: every page, token refresh and retry of a provider call shares
// it. Kept under Playwright's 30 s request timeout, so a slow provider is a typed error there.
export const OPERATION_MS = 25_000;

export const deadline = () => AbortSignal.timeout(OPERATION_MS);

// Whether `err` comes from a deadline: this caller's own, or one inside a shared step (a
// token refresh) that gave up first.
export const timedOut = (err: unknown, signal: AbortSignal) =>
  signal.aborted || ["TimeoutError", "AbortError"].includes((err as { name?: string })?.name ?? "");

// Waits for a shared promise until this caller's deadline; the promise carries on for others.
export function within<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
