import type { Pr } from "../../../server/features/github/prs.ts";
import type { AgentsSnapshot } from "../../../server/features/monitor/monitor.ts";
import type { TicketRow } from "../tickets/groups.ts";

// Inbox sources shaped as the server returns them, for the prototypes' tests and their
// worst-case data.

export const pr = (
  number: number,
  kind: Pr["kind"],
  updatedAt = "2026-10-01T08:00:00Z",
  title = `PR ${number}`,
): Pr => ({
  repo: "acme/api",
  number,
  title,
  url: `https://github.example.test/acme/api/pull/${number}`,
  author: "someone",
  draft: false,
  updatedAt,
  kind,
});

export const ticket = (
  key: string,
  category: string,
  updated = "2026-10-01T08:00:00Z",
): TicketRow => ({
  key,
  summary: key,
  status: { id: "1", name: `Estado de ${key}`, category },
  issuetype: "Task",
  assignee: null,
  parent: null,
  priority: null,
  labels: [],
  points: null,
  size: null,
  reviewers: [],
  updated,
  url: `https://jira.example.test/browse/${key}`,
});

export const outside = (
  id: string,
  over: Partial<AgentsSnapshot["outside"][number]>,
): AgentsSnapshot["outside"][number] => ({
  harness: "claude",
  id,
  pid: 1,
  cwd: "/work/repo",
  name: null,
  kind: null,
  status: null,
  state: "activa",
  startedAt: null,
  updatedAt: "2026-10-01T08:00:00Z",
  cpu: null,
  rssKb: null,
  ...over,
});

export const snapshot = (over: Partial<AgentsSnapshot>): AgentsSnapshot => ({
  app: [],
  outside: [],
  missing: [],
  ...over,
});
