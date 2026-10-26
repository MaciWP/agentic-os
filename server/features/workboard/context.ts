import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { WorkSession } from "../../../shared/workboard.ts";
import type { Config } from "../../config.ts";
import { onGithub } from "../../config.ts";
import { errorMessage } from "../../error-message.ts";
import type { EnvCache } from "../projects/routes.ts";
import { scanRepos } from "../projects/worktrees.ts";
import type { Terminals } from "../terminals/contract.ts";

export const ticketMatches = (branch: string | null, ticket: string) =>
  new RegExp(
    `(^|[^A-Za-z0-9])${ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
    "i",
  ).test(branch ?? "");
export function workboardContext(config: Config, terminals: Terminals, envs: EnvCache) {
  return async (ticket: string | null, cwd: string) => {
    const [scan, live, envList] = await Promise.all([
      scanRepos(config, await terminals.env),
      terminals.list(),
      envs
        .get()
        .then((x) => ({ envs: x.envs, error: null as string | null }))
        .catch((e) => ({ envs: [], error: errorMessage(e) })),
    ]);
    const current = await realpath(cwd).catch(() => null);
    const related = live.filter((t) => (ticket ? t.ticket === ticket : t.cwd === current));
    const repos: {
      cwd: string;
      location: string;
      repo: string;
      branch: string | null;
      github: string | null;
    }[] = [];
    const add = (repo: string, path: string, location: string | null, branch: string | null) => {
      if (!location || repos.some((r) => r.cwd === path)) return;
      if (
        path !== current &&
        !(ticket && ticketMatches(branch, ticket)) &&
        !related.some((t) => t.cwd === path)
      )
        return;
      const cfg = config.repos.find((r) => r.id === repo);
      repos.push({
        cwd: path,
        location,
        repo,
        branch,
        github: cfg && onGithub(cfg) ? `${cfg.owner}/${cfg.name}` : null,
      });
    };
    for (const r of scan.repos) {
      if (r.main) add(r.id, r.main.path, `repo:${r.id}`, r.main.branch);
      for (const w of r.worktrees) add(r.id, w.path, w.location, w.branch);
    }
    if (config.envs)
      for (const e of envList.envs)
        for (const dir of e.dirs) {
          const path = await realpath(join(config.envs.root, e.name, dir)).catch(() => null);
          if (!path) continue;
          const known = scan.envCheckouts.get(path);
          if (known) add(known.repo, path, `env:${e.name}/${dir}`, known.branch);
        }
    return {
      repos,
      sessions: related.map((t) => ({
        id: t.id,
        sessionId: t.agent?.sessionId ?? null,
        title: t.name ?? t.agent?.title ?? t.harness,
        harness: t.harness,
        cwd: t.cwd,
        state:
          t.state === "running"
            ? (t.agent?.state ?? "unknown")
            : t.state === "exited" && t.exitCode === 0
              ? "completed"
              : t.state,
        ask: t.agent?.asks ?? null,
      })),
      errors: [
        ...scan.repos.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`),
        ...(envList.error ? [envList.error] : []),
      ],
    };
  };
}
// A terminal no longer running, or running another session, has released this one.
export function workboardReleased(terminals: Terminals) {
  return async (id: string, sessionId: string) => {
    const terminal = await terminals.get(id);
    return terminal?.state !== "running" || terminal.agent?.sessionId !== sessionId;
  };
}
export function workboardActor(terminals: Terminals) {
  return async (id: string | undefined, input?: WorkSession) => {
    if (!id) throw Error("Managed terminal identity required");
    const terminal = await terminals.get(id);
    if (terminal?.state !== "running" || terminal.harness === "shell" || terminal.harness === "env")
      throw Error("Unknown managed agent");
    if (input) {
      const [cwd, expected] = await Promise.all([realpath(input.cwd), realpath(terminal.cwd)]);
      if (
        cwd !== expected ||
        (terminal.agent?.sessionId && terminal.agent.sessionId !== input.sessionId)
      )
        throw Error("Session identity mismatch");
    }
    return id;
  };
}
