import { Hono } from "hono";
import { type Config, onGithub } from "../../config.ts";
import type { GithubClient } from "./prs.ts";

export function githubRoutes(github: GithubClient, config: Config) {
  const watched = config.repos.filter(onGithub);
  // Which repos are watched, so an empty list can say whether there is nothing to watch.
  const repos = watched.map((r) => `${r.owner}/${r.name}`);
  return (
    new Hono()
      .get("/prs", async (c) =>
        config.providers.github
          ? c.json({ ...(await github.list({ fresh: c.req.query("fresh") === "1" })), repos })
          : c.json({ disabled: true as const }),
      )
      // Asks for the user's review on a PR, keeping the reviewers it has. `:repo` is a config
      // repo id: the owner and name come from config, never from the browser.
      .post("/prs/:repo/:n/reviewers", async (c) => {
        if (!config.providers.github) return c.json({ disabled: true as const });
        const repo = watched.find((r) => r.id === c.req.param("repo"));
        if (!repo) return c.json({ error: "unknown_repo" }, 404);
        const n = Number(c.req.param("n"));
        if (!Number.isSafeInteger(n) || n <= 0) return c.json({ error: "invalid_number" }, 400);
        return c.json(await github.requestReview(repo, n));
      })
  );
}
