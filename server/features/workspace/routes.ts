import { Hono } from "hono";
import { WorkspaceCommand } from "../../../shared/workspace.ts";
import type { WorkspaceStore } from "./store.ts";

export function workspaceRoutes(store: WorkspaceStore) {
  return new Hono()
    .get("/", (c) => c.json(store.read()))
    .post("/commands", async (c) => {
      const parsed = WorkspaceCommand.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: "bad_request", detail: parsed.error.issues }, 400);
      return c.json(store.apply(parsed.data));
    });
}
