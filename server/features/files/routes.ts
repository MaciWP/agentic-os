import { homedir } from "node:os";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../../config.ts";
import { listFolders, places } from "./browse.ts";

const FoldersQuery = z.object({ path: z.string().min(1).max(1024) });

// Read only. A remote device lists the host's folders too: it already runs shells there.
export const fileRoutes = (config: Config, home = homedir()) =>
  new Hono()
    .get("/folders", async (c) => {
      const query = FoldersQuery.safeParse(c.req.query());
      if (!query.success) return c.json({ error: "bad_request", detail: query.error.issues }, 400);
      return c.json(await listFolders(query.data.path));
    })
    // Home too, so a picker can write a path as ~/… even when no place is home.
    .get("/places", async (c) => c.json({ home, places: await places(config, home) }));
