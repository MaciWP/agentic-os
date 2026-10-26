import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../../deps.ts";
import { LaunchError, resolveLocation } from "../../launching.ts";
import { log } from "../../log.ts";
import { type Places, placeResolver } from "../../place.ts";
import { isEnvLocation, resolveEnvLocation } from "../envs/provider.ts";
import type { scanRepos } from "../projects/worktrees.ts";
import { GitError, GitTimeout } from "./run.ts";
import {
  applyHunk,
  commitStaged,
  discardIndex,
  discardPaths,
  discardSnapshot,
  hunksOf,
  markResolved,
  pushBranch,
  stagePaths,
  unstagePaths,
} from "./stage.ts";
import { isRepoRoot, readDiff, readStatus } from "./status.ts";
import { exclusive, fastForward, fetchRemote, GitRefusal, updateRepos } from "./sync.ts";

const Location = z.string().min(1).max(300);
const LocationBody = z.object({ location: Location });
const Path = z.string().min(1).max(4096);
const PathsBody = z.object({ location: Location, paths: z.array(Path).min(1).max(2000) });
const ResolveBody = z.object({ location: Location, path: Path });
const DiscardBody = PathsBody.extend({
  confirm: z.literal(true),
  versions: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
const HunkBody = z.object({
  location: Location,
  path: Path,
  staged: z.boolean(),
  index: z.number().int().min(0).max(100_000),
  digest: z.string().regex(/^[0-9a-f]{40}$/),
});
const CommitBody = z.object({
  location: Location,
  message: z
    .string()
    .max(10_000)
    .refine((m) => m.trim().length > 0, "the message is empty"),
});

// The tree's counts are a glance, not a check: a slow checkout gives up early.
const SUMMARY_TIMEOUT_MS = 5000;
const SUMMARY_PARALLEL = 6;

export type GitSummary = {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  changed: number;
  truncated: boolean;
};

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Every location resolves on the server from its id (server/place.ts). The reads change
// nothing; fetch and pull only move remote refs and fast-forward. Stage, commit and push
// (stage.ts) act on what the status lists, never on a path the client made up, and are not
// held back by a terminal inside: an agent working there is why they exist. After any write
// `onChange` tells the open views.
// What the configured repos hold is the projects feature's logic too; the app passes it in.
export type GitPlaces = Places & { scan: typeof scanRepos };

export function gitRoutes(
  { config, terminals, memoryRoots }: Deps,
  { scan: scanAll, ...places }: GitPlaces,
  onChange: () => void,
) {
  const { place, cachedEnvs } = placeResolver({ config, terminals }, places);

  const where = async (id: string) => {
    const { cwd, env } = await place(id);
    const at = { bin: config.git.bin ?? "", cwd, env };
    return { at, repo: Boolean(config.git.bin) && (await isRepoRoot(at)) };
  };

  const repoAt = async (location: string) => {
    const { at, repo } = await where(location);
    if (!repo) throw new GitRefusal("not_a_repo", "La carpeta no es la raíz de un repo de git.");
    return at;
  };

  // One write at a time per checkout, then the open views are told.
  const writeAt = async <T>(
    location: string,
    run: (at: Awaited<ReturnType<typeof repoAt>>) => Promise<T>,
  ) => {
    const at = await repoAt(location);
    const result = await exclusive(at.cwd, () => run(at));
    onChange();
    return result;
  };

  // A LaunchError (unknown location), a GitError and a GitRefusal reach the app's onError.
  return new Hono()
    .post("/stage", async (c) => {
      const body = PathsBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      await writeAt(body.data.location, (at) => stagePaths(at, body.data.paths));
      return c.json({ ok: true as const });
    })
    .post("/unstage", async (c) => {
      const body = PathsBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      await writeAt(body.data.location, (at) => unstagePaths(at, body.data.paths));
      return c.json({ ok: true as const });
    })
    .post("/resolve", async (c) => {
      const body = ResolveBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      await writeAt(body.data.location, (at) => markResolved(at, body.data.path));
      return c.json({ ok: true as const });
    })
    .post("/discard", async (c) => {
      const body = DiscardBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const recovery = await writeAt(body.data.location, (at) =>
        discardPaths(at, body.data.paths, body.data.versions, memoryRoots?.dataDir),
      );
      return c.json({ ok: true as const, recovery });
    })
    .post("/hunk", async (c) => {
      const body = HunkBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const { location, path, staged, index, digest } = body.data;
      await writeAt(location, (at) => applyHunk(at, path, staged, index, digest));
      return c.json({ ok: true as const });
    })
    .post("/commit", async (c) => {
      const body = CommitBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      return c.json(await writeAt(body.data.location, (at) => commitStaged(at, body.data.message)));
    })
    .post("/push", async (c) => {
      const body = LocationBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      return c.json(await writeAt(body.data.location, pushBranch));
    })
    .post("/fetch", async (c) => {
      const body = LocationBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const at = await repoAt(body.data.location);
      await exclusive(at.cwd, () => fetchRemote(at));
      onChange();
      return c.json({ ok: true as const });
    })
    .post("/pull", async (c) => {
      const body = LocationBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      // The env CLI's `update` owns its checkouts: it fetches and rebases them its own way.
      if (isEnvLocation(body.data.location)) {
        throw new GitRefusal("env_checkout", "Un checkout de entorno se actualiza con su CLI.");
      }
      const at = await repoAt(body.data.location);
      const result = await exclusive(at.cwd, () => fastForward(at, terminals));
      onChange();
      return c.json(result);
    })
    .post("/update-all", async (c) => {
      const items = await updateRepos(config, terminals);
      onChange();
      return c.json({ items });
    })
    .get("/status", async (c) => {
      const id = c.req.query("location");
      if (!id) return c.json({ error: "bad_request", detail: "location is required" }, 400);
      const { at, repo } = await where(id);
      if (!repo) return c.json({ repo: false as const });
      const status = await readStatus(at);
      const versions: Record<string, string> = {};
      const index = await discardIndex(at);
      await eachLimited(
        status.files.filter((f) => f.kind !== "untracked" && f.kind !== "conflict" && f.y !== "."),
        4,
        async (f) => {
          try {
            versions[f.path] = (await discardSnapshot(at, f.path, index.get(f.path) ?? "")).version;
          } catch {
            /* Unsupported files cannot be discarded. */
          }
        },
      );
      return c.json({ ...status, versions });
    })
    .get("/diff", async (c) => {
      const id = c.req.query("location");
      const path = c.req.query("file");
      if (!id || !path) {
        return c.json({ error: "bad_request", detail: "location and file are required" }, 400);
      }
      const { at, repo } = await where(id);
      if (!repo) return c.json({ error: "not_a_repo" }, 400);
      // Only a path git lists right now; the client's string is compared, never passed on.
      const file = (await readStatus(at)).files.find((f) => f.path === path);
      if (!file) return c.json({ error: "bad_request", detail: "file is not in git status" }, 400);
      const diff = await readDiff(at, file, c.req.query("staged") === "1");
      return c.json({ ...diff, ...hunksOf(file, diff) });
    })
    .get("/summary", async (c) => {
      const env = await terminals.env;
      const bin = config.git.bin;
      if (!bin) return c.json({ items: {} });
      const [scan, envs] = await Promise.all([scanAll(config, env), cachedEnvs()]);
      const checkouts: { location: string; cwd: () => Promise<string> }[] = [];
      for (const r of scan.repos) {
        if (r.main) {
          const id = `repo:${r.id}`;
          checkouts.push({ location: id, cwd: async () => resolveLocation(config, id).cwd });
        }
        for (const w of r.worktrees) {
          if (w.location) checkouts.push({ location: w.location, cwd: async () => w.path });
        }
      }
      for (const e of envs) {
        if (e.problem) continue;
        for (const dir of e.dirs) {
          const id = `env:${e.name}/${dir}`;
          checkouts.push({
            location: id,
            cwd: async () => (await resolveEnvLocation(config.envs, env, id, envs)).cwd,
          });
        }
      }
      const items: Record<string, GitSummary> = {};
      await eachLimited(checkouts, SUMMARY_PARALLEL, async (k) => {
        // A checkout that fails here is left out; its own status view shows the error.
        try {
          const at = { bin, cwd: await k.cwd(), env };
          if (!(await isRepoRoot(at))) return;
          const s = await readStatus(at, SUMMARY_TIMEOUT_MS);
          items[k.location] = {
            branch: s.branch,
            ahead: s.ahead,
            behind: s.behind,
            changed: s.files.length,
            truncated: s.truncated,
          };
        } catch (err) {
          if (!(err instanceof GitError || err instanceof LaunchError)) throw err;
          // The one cause of a slow summary that would otherwise leave no trace: which checkout.
          if (err instanceof GitTimeout)
            log("git").warn("summary left out a slow checkout", {
              location: k.location,
              ms: SUMMARY_TIMEOUT_MS,
            });
        }
      });
      return c.json({ items });
    });
}
