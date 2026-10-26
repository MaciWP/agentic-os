import type { EnvJob, JobSummary } from "./env-jobs.ts";
import type { Projects } from "./queries.ts";

type Envs = Projects["envs"];

// Two envs-worth of tree for component tests: one env with a checkout, a repo with a
// worktree and a detached one, a failing repo, and the app's own node.
export const projects = (envs: Partial<Envs> = {}): Projects => ({
  envs: {
    configured: true,
    error: null,
    proxy: { up: true, hosts: ["env-a.test", "front-env-a.test"] },
    repos: ["backend", "frontend"],
    items: [
      {
        name: "env-a",
        branch: "ABC-1",
        url: "https://env-a.test",
        repos: [
          { repo: "backend", branch: "ABC-1", docker: "up", servers: "2/2" },
          { repo: "contract", branch: "ABC-1", docker: null, servers: null },
        ],
        dirs: ["p-backend"],
        problem: null,
        locations: [],
        checkouts: [
          {
            dir: "p-backend",
            location: "env:env-a/p-backend",
            repo: "alpha",
            branch: "ABC-1",
            link: "https://front-env-a.test",
          },
        ],
        hosts: ["env-a.test", "front-env-a.test"],
      },
    ],
    ...envs,
  },
  repos: [
    {
      id: "alpha",
      location: "repo:alpha",
      group: "Work",
      github: "acme/alpha",
      removable: false,
      main: { path: "/src/alpha", branch: "main" },
      worktrees: [
        {
          path: "/wt/alpha/fix",
          branch: "fix",
          head: "abc",
          location: "wt:alpha:fix",
          removable: true,
        },
        { path: "/wt/alpha/old", branch: null, head: "def", location: null, removable: false },
      ],
      error: null,
    },
    {
      id: "beta",
      location: "repo:beta",
      group: null,
      github: null,
      removable: true,
      main: null,
      worktrees: [],
      error: "git exited with 128: x",
    },
  ],
  worktrees: { configured: true, error: null },
  colors: {},
  app: { location: "app", label: "Agentic OS" },
});

// An env job as the list shows it, and with its output; `withJob` seeds the query that reads it.
export const summary = (over: Partial<JobSummary> = {}): JobSummary => ({
  id: "j1",
  action: "update",
  env: "env-a",
  state: "ok",
  error: null,
  startedAt: "2026-10-05T10:00:00Z",
  endedAt: "2026-10-05T10:01:05Z",
  ...over,
});
export const job = (over: Partial<EnvJob> = {}): EnvJob => ({
  ...summary(over),
  output: "",
  truncated: false,
  ...over,
});
export const withJob = (j: EnvJob): [unknown[], unknown] => [["envjobs", "job", j.id], { job: j }];
