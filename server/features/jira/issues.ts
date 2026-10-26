import { z } from "zod";
import type { Config } from "../../config.ts";
import { deadline } from "../../deadline.ts";
import { ProviderError, parseProvider } from "../../provider-error.ts";
import { adfToMarkdown, extractAcceptanceCriteria } from "./adf.ts";
import type { JiraClient } from "./client.ts";
import { ReconnectRequired } from "./oauth.ts";

const Named = z.looseObject({ name: z.string() });
const Status = z.looseObject({
  id: z.string(),
  name: z.string(),
  statusCategory: z.looseObject({ key: z.string(), name: z.string() }),
});
const User = z.looseObject({ accountId: z.string(), displayName: z.string() });
const Option = z.looseObject({ value: z.string() });

const Fields = z.looseObject({
  summary: z.string(),
  status: Status,
  issuetype: Named,
  assignee: User.nullish(),
  priority: Named.nullish(),
  labels: z.array(z.string()).default([]),
  updated: z.string(),
  description: z.unknown().optional(),
  parent: z
    .looseObject({
      key: z.string(),
      fields: z.looseObject({ summary: z.string(), issuetype: Named }),
    })
    .nullish(),
});

export const RawIssue = z.looseObject({ key: z.string(), fields: Fields });

export type Ticket = {
  key: string;
  summary: string;
  // `id` is what boards and JQL match: `name` comes in the connected user's language.
  status: { id: string; name: string; category: string };
  issuetype: string;
  assignee: { accountId: string; displayName: string } | null;
  parent: { key: string; summary: string; type: string } | null;
  priority: string | null;
  labels: string[];
  points: number | null;
  size: string | null;
  // Who reviews it, from the configured reviewer field; empty when the field is not set.
  reviewers: { accountId: string; displayName: string }[];
  updated: string;
  url: string;
  descriptionAdf: unknown;
  descriptionMd: string;
  acceptanceCriteria: string[];
};

// What reading and writing tickets needs; the boards matter only to the Tickets page.
type JiraConfig = Omit<NonNullable<Config["jira"]>, "boards">;

export function issueFields(jira: JiraConfig) {
  const base = [
    "summary",
    "status",
    "issuetype",
    "assignee",
    "priority",
    "labels",
    "updated",
    "parent",
  ];
  return [...base, jira.fields.points, jira.fields.size, jira.fields.reviewer].filter(
    (f): f is string => Boolean(f),
  );
}

// The ticket's page on the configured Jira site.
export const browseUrl = (jira: Pick<JiraConfig, "site">, key: string) =>
  `${jira.site.replace(/\/+$/, "")}/browse/${key}`;

export function normalizeIssue(raw: z.infer<typeof RawIssue>, jira: JiraConfig): Ticket {
  const f = raw.fields;
  const custom = f as Record<string, unknown>;
  const points = jira.fields.points
    ? parseProvider("jira", z.number().nullish(), custom[jira.fields.points])
    : null;
  const size = jira.fields.size
    ? parseProvider("jira", Option.nullish(), custom[jira.fields.size])
    : null;
  const reviewers = jira.fields.reviewer
    ? parseProvider("jira", z.array(User).nullish(), custom[jira.fields.reviewer])
    : null;
  const descriptionMd = adfToMarkdown(f.description);
  return {
    key: raw.key,
    summary: f.summary,
    status: { id: f.status.id, name: f.status.name, category: f.status.statusCategory.key },
    issuetype: f.issuetype.name,
    assignee: f.assignee
      ? { accountId: f.assignee.accountId, displayName: f.assignee.displayName }
      : null,
    parent: f.parent
      ? {
          key: f.parent.key,
          summary: f.parent.fields.summary,
          type: f.parent.fields.issuetype.name,
        }
      : null,
    priority: f.priority?.name ?? null,
    labels: f.labels,
    points: points ?? null,
    size: size?.value ?? null,
    reviewers: (reviewers ?? []).map((u) => ({
      accountId: u.accountId,
      displayName: u.displayName,
    })),
    updated: f.updated,
    url: browseUrl(jira, raw.key),
    descriptionAdf: f.description ?? null,
    descriptionMd,
    acceptanceCriteria: extractAcceptanceCriteria(descriptionMd),
  };
}

export async function getIssue(
  jira: Pick<JiraClient, "request">,
  config: Config,
  key: string,
): Promise<Ticket> {
  if (!config.jira) throw new Error("data/config.json has no jira section");
  const fields = [...issueFields(config.jira), "description"].join(",");
  const raw = await jira.request(RawIssue, `/rest/api/3/issue/${key}?fields=${fields}`);
  return normalizeIssue(raw, config.jira);
}

const CommentPage = z.looseObject({
  comments: z.array(
    z.looseObject({
      author: z.looseObject({ displayName: z.string() }).nullish(),
      created: z.string(),
      body: z.unknown().optional(),
    }),
  ),
  total: z.number().int().nonnegative().optional(),
});

export type TicketComment = { author: string; created: string; body: string };

const COMMENT_PAGE = 100;
// ponytail: 1000 comments (10 pages); the bring budget keeps only the newest that fit anyway.
const MAX_COMMENT_PAGES = 10;

// A ticket's comments, oldest first: asked newest first, page by page while Jira says there
// are more, and turned around.
export async function getComments(
  jira: Pick<JiraClient, "request">,
  key: string,
): Promise<TicketComment[]> {
  const base = `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${COMMENT_PAGE}`;
  const raw: z.infer<typeof CommentPage>["comments"] = [];
  for (let n = 0; n < MAX_COMMENT_PAGES; n++) {
    const page = await jira.request(CommentPage, n === 0 ? base : `${base}&startAt=${raw.length}`);
    raw.push(...page.comments);
    if (page.comments.length === 0 || raw.length >= (page.total ?? raw.length)) break;
  }
  return raw
    .map((c) => ({
      author: c.author?.displayName ?? "?",
      created: c.created,
      body: adfToMarkdown(c.body),
    }))
    .reverse();
}

// Enhanced search (POST /rest/api/3/search/jql): cursor pagination with nextPageToken.
const SearchPage = z.looseObject({
  issues: z.array(RawIssue),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

function projectKey(project: string) {
  if (!PROJECT_KEY.test(project)) throw new Error(`Invalid Jira project key in config: ${project}`);
  return project;
}

export function myOpenIssuesJql(project: string): string {
  return `project = ${projectKey(project)} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
}

// The whole team's open tickets: anyone's, and nobody's.
export function teamOpenIssuesJql(project: string): string {
  return `project = ${projectKey(project)} AND statusCategory != Done ORDER BY updated DESC`;
}

export type BoardConfig = NonNullable<Config["jira"]>["boards"][number];

// One board's open tickets, as the board shows them: its own restriction, only the statuses
// its columns hold (by id, digits only), in the board's rank order.
export function boardIssuesJql(project: string, board: BoardConfig): string {
  const statuses = board.columns.flatMap((c) => c.statuses);
  return [
    `project = ${projectKey(project)}`,
    "statusCategory != Done",
    ...(board.jql ? [`(${board.jql})`] : []),
    `status in (${statuses.join(", ")})`,
  ]
    .join(" AND ")
    .concat(" ORDER BY Rank ASC");
}

// Adds the connected user to the ticket's reviewers. Jira's `add` operation keeps whoever is
// there already; it never replaces them. Answers 204 with no body.
export async function addReviewer(
  jira: Pick<JiraClient, "request" | "connection">,
  jiraConfig: JiraConfig,
  key: string,
): Promise<{ accountId: string }> {
  const field = jiraConfig.fields.reviewer;
  if (!field) throw new ProviderError("jira", 409, "data/config.json has no jira.fields.reviewer");
  const me = jira.connection();
  if (!me) throw new ReconnectRequired("not connected");
  try {
    await jira.request(z.unknown(), `/rest/api/3/issue/${key}`, {
      method: "PUT",
      body: JSON.stringify({ update: { [field]: [{ add: { accountId: me.accountId } }] } }),
    });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403)
      throw new ProviderError(
        "jira",
        403,
        `Jira 403 editing ${key}: this connection may not edit it; reconnect Jira or ask for edit rights`,
      );
    throw err;
  }
  return { accountId: me.accountId };
}

const Transitions = z.looseObject({
  transitions: z.array(z.looseObject({ id: z.string(), to: z.looseObject({ id: z.string() }) })),
});

// Moves a ticket into a status, by its id, through the transition Jira offers to it now.
export async function moveToStatus(
  jira: Pick<JiraClient, "request">,
  key: string,
  statusId: string,
): Promise<void> {
  const { transitions } = await jira.request(Transitions, `/rest/api/3/issue/${key}/transitions`);
  const t = transitions.find((x) => x.to.id === statusId);
  if (!t) throw new ProviderError("jira", 409, `${key} has no transition to status ${statusId}`);
  await jira.request(z.unknown(), `/rest/api/3/issue/${key}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: t.id } }),
  });
}

// Assigns a ticket to the connected user. Answers 204 with no body.
export async function assignToMe(
  jira: Pick<JiraClient, "request" | "connection">,
  key: string,
): Promise<void> {
  const me = jira.connection();
  if (!me) throw new ReconnectRequired("not connected");
  await jira.request(z.unknown(), `/rest/api/3/issue/${key}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ accountId: me.accountId }),
  });
}

export async function searchAllIssues(
  jira: Pick<JiraClient, "request">,
  jiraConfig: JiraConfig,
  jql: string,
  opts: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
): Promise<Ticket[]> {
  // One deadline for the whole search, every page included.
  const { pageSize = 50, maxPages = 20, signal = deadline() } = opts;
  const seen = new Set<string>();
  const tickets: Ticket[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = {
      jql,
      fields: issueFields(jiraConfig),
      maxResults: pageSize,
      nextPageToken: token,
    };
    const res = await jira.request(SearchPage, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
    tickets.push(...res.issues.map((raw) => normalizeIssue(raw, jiraConfig)));
    const next = res.nextPageToken ?? undefined;
    if (!next || res.isLast === true) return tickets;
    if (seen.has(next)) throw new Error("Jira returned a repeated page cursor");
    seen.add(next);
    token = next;
  }
  throw new Error(`Jira search exceeded ${maxPages} pages`);
}
