// The server's port and its remote ingress listen before the app is built, so a request that
// arrives early, or after a restart began, gets 503 "Starting" and not a refused connection.
type App = { fetch: (req: Request, env?: unknown) => Response | Promise<Response> };

export function readyGate() {
  let app: App | undefined;
  return {
    fetch: (req: Request, env?: unknown) =>
      app ? app.fetch(req, env) : new Response("Starting", { status: 503 }),
    serve: (ready: App) => {
      app = ready;
    },
    quiesce: () => {
      app = undefined;
    },
  };
}
