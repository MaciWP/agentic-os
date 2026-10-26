import { describe, expect, test } from "bun:test";
import { ProviderError } from "../../provider-error.ts";
import {
  addReviewer,
  boardIssuesJql,
  getComments,
  issueFields,
  myOpenIssuesJql,
  normalizeIssue,
  RawIssue,
  searchAllIssues,
  teamOpenIssuesJql,
} from "./issues.ts";
import { ReconnectRequired } from "./oauth.ts";

const jira = {
  site: "https://example.atlassian.net/",
  project: "ABC",
  callbackUrl: "http://localhost:4317/auth/atlassian/callback",
  fields: { points: "customfield_1", size: "customfield_2", reviewer: "customfield_3" },
};

const raw = {
  key: "ABC-7",
  fields: {
    summary: "Do the thing",
    status: {
      id: "20005",
      name: "In Product Review",
      statusCategory: { key: "indeterminate", name: "In progress" },
    },
    issuetype: { name: "Tarea" },
    assignee: { accountId: "u1", displayName: "Someone" },
    priority: { name: "High" },
    labels: ["x"],
    updated: "2026-09-29T15:02:49.982+0200",
    parent: { key: "ABC-1", fields: { summary: "Epic one", issuetype: { name: "Epic" } } },
    customfield_1: 2,
    customfield_2: { value: "XS", id: "1" },
    customfield_3: [
      { accountId: "u2", displayName: "Reviewer Two", active: true },
      { accountId: "u3", displayName: "Reviewer Three" },
    ],
    description: { type: "doc", version: 1, content: [] },
  },
};

describe("normalizeIssue", () => {
  test("keeps tracker values unchanged and reads configured fields", () => {
    const t = normalizeIssue(RawIssue.parse(raw), jira);
    expect(t.status).toEqual({ id: "20005", name: "In Product Review", category: "indeterminate" });
    expect(t.parent).toEqual({ key: "ABC-1", summary: "Epic one", type: "Epic" });
    expect(t.points).toBe(2);
    expect(t.size).toBe("XS");
    expect(t.url).toBe("https://example.atlassian.net/browse/ABC-7");
    expect(t.descriptionAdf).toEqual(raw.fields.description);
    expect(t.reviewers).toEqual([
      { accountId: "u2", displayName: "Reviewer Two" },
      { accountId: "u3", displayName: "Reviewer Three" },
    ]);
  });

  test("no reviewer field configured, or none set, is no reviewers", () => {
    const none = { key: "ABC-6", fields: { ...raw.fields, customfield_3: null } };
    expect(normalizeIssue(RawIssue.parse(none), jira).reviewers).toEqual([]);
    const off = { ...jira, fields: { points: "customfield_1", size: "customfield_2" } };
    expect(normalizeIssue(RawIssue.parse(raw), off).reviewers).toEqual([]);
  });

  test("tolerates empty optional fields", () => {
    const empty = {
      key: "ABC-8",
      fields: {
        ...raw.fields,
        assignee: null,
        priority: null,
        parent: undefined,
        customfield_1: null,
        customfield_2: null,
      },
    };
    const t = normalizeIssue(RawIssue.parse(empty), jira);
    expect([t.assignee, t.priority, t.parent, t.points, t.size]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("rejects a wrongly typed custom field instead of guessing", () => {
    const bad = { key: "ABC-9", fields: { ...raw.fields, customfield_1: "two" } };
    expect(() => normalizeIssue(RawIssue.parse(bad), jira)).toThrow();
  });

  test("requests the configured custom fields", () => {
    expect(issueFields(jira)).toContain("customfield_1");
    expect(issueFields(jira)).toContain("customfield_3");
    expect(issueFields({ ...jira, fields: {} })).not.toContain(undefined);
  });
});

type Page = { issues: unknown[]; nextPageToken?: string; isLast?: boolean };

function fakeJira(pages: Page[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  return {
    bodies,
    request: async <S extends import("zod").ZodType>(
      schema: S,
      _path: string,
      init: RequestInit = {},
    ) => {
      bodies.push(JSON.parse(String(init.body)));
      const page = pages[i++];
      if (!page) throw new ProviderError("jira", 500, "no more pages");
      return schema.parse(page) as import("zod").infer<S>;
    },
  };
}

const issue = (key: string) => ({ ...raw, key });

describe("searchAllIssues", () => {
  test("follows nextPageToken until the last page", async () => {
    const client = fakeJira([
      { issues: [issue("ABC-1"), issue("ABC-2")], nextPageToken: "t1" },
      { issues: [issue("ABC-3")], nextPageToken: "t2" },
      { issues: [issue("ABC-4")], isLast: true },
    ]);
    const tickets = await searchAllIssues(client, jira, "jql", { pageSize: 2 });
    expect(tickets.map((t) => t.key)).toEqual(["ABC-1", "ABC-2", "ABC-3", "ABC-4"]);
    expect(client.bodies.map((b) => b.nextPageToken)).toEqual([undefined, "t1", "t2"]);
    expect(client.bodies[0]?.maxResults).toBe(2);
  });

  test("rejects a repeated cursor instead of looping", async () => {
    const client = fakeJira([
      { issues: [issue("ABC-1")], nextPageToken: "same" },
      { issues: [issue("ABC-2")], nextPageToken: "same" },
    ]);
    await expect(searchAllIssues(client, jira, "jql")).rejects.toThrow("repeated page cursor");
  });

  test("a provider error is an error, never an empty list", async () => {
    const client = fakeJira([]);
    await expect(searchAllIssues(client, jira, "jql")).rejects.toBeInstanceOf(ProviderError);
  });

  test("builds the frozen JQL and refuses an unsafe project key", () => {
    expect(myOpenIssuesJql("ABC")).toBe(
      "project = ABC AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    );
    expect(() => myOpenIssuesJql("ABC OR 1=1")).toThrow();
    expect(teamOpenIssuesJql("ABC")).toBe(
      "project = ABC AND statusCategory != Done ORDER BY updated DESC",
    );
    expect(() => teamOpenIssuesJql("ABC OR 1=1")).toThrow();
  });

  test("a board's JQL asks for its statuses by id, in the board's rank order", () => {
    const board = {
      id: "b",
      name: "B",
      jql: "sprint in openSprints()",
      columns: [
        { name: "TO DO", statuses: ["20003", "20002"] },
        { name: "PR", statuses: ["20004"] },
      ],
    };
    expect(boardIssuesJql("ABC", board)).toBe(
      "project = ABC AND statusCategory != Done AND (sprint in openSprints()) AND status in (20003, 20002, 20004) ORDER BY Rank ASC",
    );
    expect(() => boardIssuesJql("ABC OR 1=1", board)).toThrow();
  });
});

describe("addReviewer", () => {
  type Sent = { path: string; method?: string; body: unknown };
  const writer = (
    answer: () => unknown,
    me: { accountId: string } | null = { accountId: "me1" },
  ) => {
    const sent: Sent[] = [];
    return {
      sent,
      connection: () =>
        me ? { ...me, cloudId: "c", siteUrl: "https://example.atlassian.net" } : null,
      request: async <S extends import("zod").ZodType>(
        schema: S,
        path: string,
        init: RequestInit = {},
      ) => {
        sent.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
        return schema.parse(answer()) as import("zod").infer<S>;
      },
    };
  };

  test("adds the user with Jira's add operation, which keeps the other reviewers", async () => {
    const client = writer(() => undefined);
    expect(await addReviewer(client, jira, "ABC-7")).toEqual({ accountId: "me1" });
    expect(client.sent).toEqual([
      {
        path: "/rest/api/3/issue/ABC-7",
        method: "PUT",
        body: { update: { customfield_3: [{ add: { accountId: "me1" } }] } },
      },
    ]);
  });

  test("without a reviewer field it refuses before writing anything", async () => {
    const client = writer(() => undefined);
    const off = { ...jira, fields: {} };
    await expect(addReviewer(client, off, "ABC-7")).rejects.toThrow("jira.fields.reviewer");
    expect(client.sent).toEqual([]);
  });

  test("without a connection it asks to reconnect", async () => {
    const client = writer(() => undefined, null);
    await expect(addReviewer(client, jira, "ABC-7")).rejects.toBeInstanceOf(ReconnectRequired);
    expect(client.sent).toEqual([]);
  });

  test("a 403 says the connection may not edit the ticket; other errors pass as they are", async () => {
    const forbidden = writer(() => {
      throw new ProviderError("jira", 403, "Jira 403 on /rest/api/3/issue/ABC-7: nope");
    });
    await expect(addReviewer(forbidden, jira, "ABC-7")).rejects.toThrow("may not edit it");
    const down = writer(() => {
      throw new ProviderError("jira", 503, "Jira 503");
    });
    await expect(addReviewer(down, jira, "ABC-7")).rejects.toThrow("Jira 503");
  });
});

describe("getComments", () => {
  const adf = (text: string) => ({
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  test("asks for the newest and returns them oldest first, as Markdown", async () => {
    const paths: string[] = [];
    const fake = {
      request: async <S extends import("zod").ZodType>(schema: S, path: string) => {
        paths.push(path);
        return schema.parse({
          comments: [
            {
              author: { displayName: "Ana" },
              created: "2026-10-02T10:00:00.000+0200",
              body: adf("Hecho"),
            },
            // A deleted user has no author.
            { author: null, created: "2026-10-01T09:00:00.000+0200", body: adf("¿Y el logout?") },
          ],
        }) as import("zod").infer<S>;
      },
    };
    expect(await getComments(fake, "ABC-7")).toEqual([
      { author: "?", created: "2026-10-01T09:00:00.000+0200", body: "¿Y el logout?" },
      { author: "Ana", created: "2026-10-02T10:00:00.000+0200", body: "Hecho" },
    ]);
    expect(paths).toEqual(["/rest/api/3/issue/ABC-7/comment?orderBy=-created&maxResults=100"]);
  });

  test("pages on while Jira counts more, so no comment is left out", async () => {
    const paths: string[] = [];
    // 230 comments, newest first: c229 … c0.
    const all = Array.from({ length: 230 }, (_, i) => ({
      author: { displayName: "Ana" },
      created: `2026-10-01T09:00:00.${String(229 - i).padStart(3, "0")}+0200`,
      body: adf(`c${229 - i}`),
    }));
    const fake = {
      request: async <S extends import("zod").ZodType>(schema: S, path: string) => {
        paths.push(path);
        const at = Number(path.match(/startAt=(\d+)/)?.[1] ?? 0);
        return schema.parse({
          comments: all.slice(at, at + 100),
          total: all.length,
        }) as import("zod").infer<S>;
      },
    };
    const got = await getComments(fake, "ABC-7");
    expect(got).toHaveLength(230);
    expect(got[0]?.body).toBe("c0");
    expect(got.at(-1)?.body).toBe("c229");
    expect(paths.map((p) => p.match(/startAt=\d+/)?.[0] ?? "first")).toEqual([
      "first",
      "startAt=100",
      "startAt=200",
    ]);
  });

  test("a failed read is an error, not an empty discussion", async () => {
    const fake = {
      request: async () => {
        throw new ProviderError("jira", 500, "boom");
      },
    };
    await expect(getComments(fake, "ABC-7")).rejects.toThrow("boom");
  });
});
