// What env commands and the forms that start them share, so the browser checks what the
// server checks.

// A ticket key. A new env for it checks out `feature/<key>`, as the team names branches.
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
export const ticketBranch = (key: string) => `feature/${key}`;

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The first known key the text names as a whole word, any case: "abc-732/web" names ABC-732,
// "ABC-7320" does not.
export function keyIn(text: string | null | undefined, keys: readonly string[]): string | null {
  if (!text) return null;
  for (const key of keys)
    if (new RegExp(`(^|[^A-Za-z0-9])${literal(key)}($|[^A-Za-z0-9])`, "i").test(text)) return key;
  return null;
}

// A branch someone else pushed (a PR's head), as git allows it and never an option: no
// leading dash, no `..`, no trailing `/` or `.lock`.
export const BRANCH = /^(?![-/])(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;

// The commands the app runs on the env provider; server/features/envs/actions.ts holds each argv.
export const ENV_ACTIONS = ["start", "stop", "update", "remove", "logs", "doctor"] as const;
export type EnvAction = (typeof ENV_ACTIONS)[number];

// An env name as the provider accepts it; it is also a directory under the envs root.
export const ENV_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

// Whether removing an env loses nothing: no uncommitted change and no commit in no remote,
// as the provider's dry run lists them per repo.
export const isClean = (p: {
  dirty: Record<string, string[]>;
  unpublished: Record<string, string[]>;
}) => Object.keys(p.dirty).length + Object.keys(p.unpublished).length === 0;

export type EnvState = "busy" | "up" | "partial" | "down" | "unknown";

// Commands that change whether an env's servers run, while they are still running.
const CHANGING = new Set(["create", "start", "stop", "update", "remove"]);

// Whether an env's dev servers run, from the provider's list: each repo reports "stopped" or
// the servers alive. A command still changing them wins (in a terminal or a job), since the
// list is from before it.
export function envState(
  repos: { servers: string | null }[],
  commands: { state: string; action: string | null }[] = [],
): EnvState {
  if (commands.some((t) => t.state === "running" && t.action && CHANGING.has(t.action)))
    return "busy";
  const known = repos.filter((r) => r.servers !== null);
  if (known.length === 0) return "unknown";
  const up = known.filter((r) => r.servers !== "stopped").length;
  return up === known.length ? "up" : up === 0 ? "down" : "partial";
}
