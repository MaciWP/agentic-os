import { Hono } from "hono";
import { KickoffRequest, type Kickoffs } from "./run.ts";

export function kickoffRoutes(kickoffs: Kickoffs) {
  return (
    new Hono()
      .get("/", (c) => c.json({ kickoffs: kickoffs.list() }))
      // Answers at once with the chain's first state; its steps come through the "kickoff" event.
      .post("/", async (c) => {
        const body = KickoffRequest.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json({ kickoff: kickoffs.start(body.data) }, 202);
      })
  );
}
