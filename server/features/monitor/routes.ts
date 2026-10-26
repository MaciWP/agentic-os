import { Hono } from "hono";
import { z } from "zod";
import { CONVERSATION } from "../../../shared/terminals.ts";
import type { Deps } from "../../deps.ts";
import { terminalConversation } from "../agents/conversation.ts";
import type { SessionSources } from "../sessions/scan.ts";
import { agentsSnapshot, type ProcRow } from "./monitor.ts";

export function agentRoutes(
  { terminals }: Deps,
  sessions: SessionSources,
  ps?: () => Promise<ProcRow[]>,
) {
  return (
    new Hono()
      .get("/", async (c) => c.json(await agentsSnapshot({ terminals, sessions, ps })))
      // What an agent terminal said, for reading on a phone. Read only: it never attaches, so
      // the window that holds the terminal keeps it and its size.
      .get("/:id/conversation", async (c) => {
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(CONVERSATION.max)
          .catch(CONVERSATION.limit)
          .parse(c.req.query("limit") ?? CONVERSATION.limit);
        const t = (await terminals.list()).find((x) => x.id === c.req.param("id"));
        if (!t) return c.json({ error: "not_found" }, 404);
        const messages = await terminalConversation(sessions.home, t, limit);
        if (!messages) return c.json({ error: "no_conversation" }, 409);
        return c.json({ messages });
      })
  );
}
