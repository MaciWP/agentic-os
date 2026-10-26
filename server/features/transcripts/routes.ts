import { Hono } from "hono";
import { DecideBody, NamesBody, StartBody } from "./contracts.ts";
import { ProposalBody } from "./proposals.ts";
import type { Review } from "./review.ts";
import type { Transcripts } from "./runner.ts";
import { TranscriptError } from "./store.ts";

const bad = (issues: unknown) => ({ error: "bad_request", detail: issues });

export function transcriptRoutes({
  transcripts,
  review,
}: {
  transcripts: Transcripts;
  review: Review;
}) {
  return (
    new Hono()
      .post("/start", async (c) => {
        const body = StartBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json(bad(body.error.issues), 400);
        return c.json({ recording: await transcripts.start(body.data) }, 201);
      })
      .post("/:id/stop", (c) => c.json({ recording: transcripts.stop(c.req.param("id")) }))
      .get("/", (c) => c.json({ recordings: transcripts.list() }))
      .get("/:id", (c) => c.json({ transcript: transcripts.detail(c.req.param("id")) }))
      .put("/:id/speakers", async (c) => {
        const body = NamesBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json(bad(body.error.issues), 400);
        transcripts.setNames(c.req.param("id"), body.data.names);
        return c.json({ transcript: transcripts.detail(c.req.param("id")) });
      })
      // The agent's proposals (through `aos transcript propose`) and the user's call on each.
      .get("/:id/proposals", (c) =>
        c.json({
          proposals: review.read(c.req.param("id")),
          reviewAt: review.startedAt(c.req.param("id")),
        }),
      )
      .post("/:id/proposals", async (c) => {
        const body = ProposalBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json(bad(body.error.issues), 400);
        return c.json({ proposals: review.propose(c.req.param("id"), body.data) });
      })
      .post("/:id/proposals/:item", async (c) => {
        // Attribution, not authentication: the agent proposes, only the user decides.
        if (c.req.header("x-aos-agent-id"))
          throw new TranscriptError(
            403,
            "user_decision_required",
            "Only the user accepts a proposal",
          );
        const body = DecideBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json(bad(body.error.issues), 400);
        const { state, text } = body.data;
        return c.json({
          proposals: await review.decide(c.req.param("id"), c.req.param("item"), state, text),
        });
      })
      // «Reintentar»: a new agent run, for a recording whose first one failed or was closed.
      .post("/:id/review", async (c) => {
        await review.start(transcripts.get(c.req.param("id")), { again: true });
        return c.json({ ok: true });
      })
  );
}
