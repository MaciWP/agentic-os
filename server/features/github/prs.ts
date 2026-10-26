import { z } from "zod";
import { cached } from "../../cache.ts";
import { type Config, type GithubRepo, onGithub } from "../../config.ts";
import { deadline, timedOut, within } from "../../deadline.ts";
import { ProviderError } from "../../provider-error.ts";
import { run } from "../../run.ts";

const API = "https://api.github.com";
const ACCOUNT_TTL_MS = 10 * 60_000;
const CACHE_MS = 30_000;

export type PrKind = "review" | "mine" | "open";
export type Pr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  updatedAt: string;
  kind: PrKind;
};

const Item = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  user: z.looseObject({ login: z.string() }).nullable(),
  draft: z.boolean().optional(),
  updated_at: z.string(),
  repository_url: z.string(),
});
const Search = z.looseObject({
  items: z.array(Item),
  total_count: z.number().int().optional(),
  incomplete_results: z.boolean().optional(),
});
const Pull = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  user: z.looseObject({ login: z.string() }).nullable(),
  head: z.looseObject({ ref: z.string(), sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  body: z.string().nullish(),
  draft: z.boolean().optional(),
  labels: z.array(z.looseObject({ name: z.string() })).default([]),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changed_files: z.number().int().optional(),
});
export type PullInfo = {
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  // The PR's commit: a branch of the same name elsewhere may hold other code.
  headSha: string;
  base: string;
  open: boolean;
  body: string;
  draft: boolean;
  labels: string[];
  changes: { files: number; additions: number; deletions: number } | null;
};

const Author = z.looseObject({ login: z.string() }).nullable();
const IssueComments = z.array(
  z.looseObject({ user: Author, created_at: z.string(), body: z.string().nullish() }),
);
const Reviews = z.array(
  z.looseObject({
    user: Author,
    state: z.string(),
    submitted_at: z.string().nullish(),
    body: z.string().nullish(),
  }),
);
const ReviewComments = z.array(
  z.looseObject({
    user: Author,
    created_at: z.string(),
    body: z.string(),
    path: z.string(),
    line: z.number().int().nullish(),
    original_line: z.number().int().nullish(),
  }),
);

// The PR as GitHub answers a review request; only its number is checked.
const Requested = z.looseObject({ number: z.number().int().positive() });

// One comment of a PR's discussion: the conversation, a review, or a comment on a line.
export type PullComment = { author: string; created: string; body: string; where?: string };

type Run = (argv: string[], signal?: AbortSignal) => Promise<{ code: number; out: string }>;

// A search of 100 PRs with headers is well under a megabyte; the cap only bounds a runaway.
const gh: Run = async (argv, signal) => {
  const r = await run(argv, { timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024, signal });
  return { code: r.code ?? -1, out: r.stdout };
};

const User = z.looseObject({ login: z.string() });

// Only links into this repo on github.com reach the browser.
const prUrl = (repo: GithubRepo, n: number) =>
  `https://${repo.host}/${repo.owner}/${repo.name}/pull/${n}`;

// `onChange`: past the 30 s, a read answers the kept inbox at once and loads it again behind
// it; this says when that load brought something else.
export function githubClient(
  config: Config,
  deps: { run?: Run; deadline?: () => AbortSignal; onChange?: () => void; now?: () => number } = {},
) {
  const exec = deps.run ?? gh;
  const operation = deps.deadline ?? deadline;
  const repos = config.repos.filter(onGithub);
  type Inbox = { prs: Pr[]; errors: string[] };
  // A load with a failed login: returned, never kept, so a fixed gh login shows on the next read.
  const failed = new WeakSet<Inbox>();
  // gh's active account, one lookup shared by concurrent requests, with its own deadline so one
  // caller giving up does not fail the others. A failed lookup is not kept.
  const active = cached(() => api(User, "/user", operation()).then((u) => u.login), {
    ttlMs: ACCOUNT_TTL_MS,
  });
  const inbox = cached(() => load(), {
    ttlMs: CACHE_MS,
    keep: (v) => !failed.has(v),
    onChange: deps.onChange,
    now: deps.now,
  });
  const invalidate = () => {
    inbox.invalidate();
    active.invalidate();
  };

  // gh makes every call with its own login, so the token never leaves gh: it is never in
  // this process, a response, a log or a terminal's environment. Asking gh for the token
  // (`gh auth token`) is what endpoint security software reports as a credential access attempt.
  // A write passes its method and its fields, each sent as `-f name=value`.
  type Write = { method: "POST"; fields: [string, string][] };
  async function api<S extends z.ZodType>(
    schema: S,
    path: string,
    signal: AbortSignal,
    write?: Write,
  ) {
    const bin = config.github.bin;
    if (!bin) throw new ProviderError("github", 503, "github.bin is not set");
    const where = path.split("?")[0];
    const sends = write
      ? ["-X", write.method, ...write.fields.flatMap(([k, v]) => ["-f", `${k}=${v}`])]
      : [];
    const { out } = await exec(
      [bin, "api", "-i", "--hostname", "github.com", ...sends, path],
      signal,
    ).catch(() => ({ code: -1, out: "" }));
    if (signal.aborted)
      throw new ProviderError("github", 504, `GitHub did not answer in time on ${where}`);
    // `-i` prints the status line and headers, a blank line, then the body.
    const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(out)?.[1]);
    // No status line: gh reached nothing. Its stderr is not passed on.
    if (!status) throw new ProviderError("github", 503, `gh could not reach GitHub on ${where}`);
    // The status alone: GitHub bodies are not echoed, so nothing sensitive can ride along.
    if (status === 401)
      throw new ProviderError("github", 401, `GitHub 401 on ${where}; run gh auth login`);
    if (status < 200 || status > 299)
      throw new ProviderError("github", status, `GitHub ${status} on ${where}`);
    const blank = out.search(/\r?\n\r?\n/);
    let body: unknown;
    try {
      body = JSON.parse(blank < 0 ? "" : out.slice(blank));
    } catch {
      // A dropped body or a non-JSON 200 (a proxy page) is a provider failure, not a crash.
      throw new ProviderError("github", 502, `GitHub sent no JSON on ${where}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new ProviderError("github", 502, `GitHub response changed shape on ${where}`);
    return parsed.data as z.infer<S>;
  }

  // gh has no per-call account: a repo whose login is not gh's active account is an error,
  // never read with someone else's access. `signal` is the operation's deadline.
  async function request<S extends z.ZodType>(
    schema: S,
    login: string,
    path: string,
    signal: AbortSignal,
    write?: Write,
  ) {
    const current = await within(active.get({ fresh: Boolean(write) }), signal).catch((err) => {
      throw timedOut(err, signal)
        ? new ProviderError("github", 504, `GitHub did not answer in time on ${path.split("?")[0]}`)
        : err;
    });
    if (current.toLowerCase() !== login.toLowerCase())
      throw new ProviderError(
        "github",
        409,
        `gh's active account is ${current}; run gh auth switch --user ${login}`,
      );
    return api(schema, path, signal, write);
  }

  // GitHub owner and repo names are case-insensitive; config may not use GitHub's casing.
  const byRepoUrl = (url: string) =>
    repos.find((r) => url.toLowerCase() === `${API}/repos/${r.owner}/${r.name}`.toLowerCase());

  // A search that left PRs out says so: one page of 100 is all it reads.
  // ponytail: one page per search, page through when an account has more than 100 open PRs.
  const shortfall = (login: string, what: string, r: z.infer<typeof Search>) =>
    r.incomplete_results
      ? `GitHub returned incomplete results for ${login}'s ${what}`
      : r.total_count !== undefined && r.total_count > r.items.length
        ? `Only ${r.items.length} of ${r.total_count} ${what} of ${login} are shown`
        : null;

  async function forLogin(
    login: string,
    repos: GithubRepo[],
    signal: AbortSignal,
  ): Promise<{ prs: Pr[]; notes: string[] }> {
    const scope = repos.map((r) => `repo:${r.owner}/${r.name}`).join(" ");
    const search = (q: string) =>
      request(
        Search,
        login,
        `/search/issues?per_page=100&sort=updated&q=${encodeURIComponent(`is:pr is:open archived:false ${q} ${scope}`)}`,
        signal,
      );
    const [open, requested] = await Promise.all([search(""), search("review-requested:@me")]);
    const notes = [
      shortfall(login, "open PRs", open),
      shortfall(login, "review requests", requested),
    ].filter((n) => n !== null);
    const asked = new Set(requested.items.map((i) => i.html_url));
    const out: Pr[] = [];
    for (const item of open.items) {
      const repo = byRepoUrl(item.repository_url);
      if (!repo) continue;
      const author = item.user?.login ?? "?";
      out.push({
        repo: repo.id,
        number: item.number,
        title: item.title,
        url: prUrl(repo, item.number),
        author,
        draft: item.draft ?? false,
        updatedAt: item.updated_at,
        kind: asked.has(item.html_url)
          ? "review"
          : author.toLowerCase() === login.toLowerCase()
            ? "mine"
            : "open",
      });
    }
    return { prs: out, notes };
  }

  const ORDER: Record<PrKind, number> = { review: 0, mine: 1, open: 2 };

  async function load(): Promise<Inbox> {
    const logins = Map.groupBy(repos, (r) => r.login);
    const prs: Pr[] = [];
    const errors: string[] = [];
    // A cut-short search is said beside the PRs, but the result is still kept.
    let failing = false;
    const signal = operation();
    await Promise.all(
      [...logins].map(async ([login, repos]) => {
        try {
          const found = await forLogin(login, repos, signal);
          prs.push(...found.prs);
          errors.push(...found.notes);
        } catch (err) {
          if (!(err instanceof ProviderError || err instanceof z.ZodError)) throw err;
          failing = true;
          errors.push(
            err instanceof ProviderError
              ? err.message
              : `GitHub response for ${login} changed shape`,
          );
        }
      }),
    );
    prs.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.updatedAt.localeCompare(a.updatedAt));
    const value = { prs, errors };
    if (failing) failed.add(value);
    return value;
  }

  return {
    // Review requests, my own open PRs, then the rest of the open PRs in the configured repos.
    // Concurrent callers share one load.
    // ponytail: 30 s cache and 100 PRs per login; paginate if a repo set ever exceeds that.
    list({ fresh = false }: { fresh?: boolean } = {}): Promise<Inbox> {
      if (fresh) invalidate();
      return inbox.get();
    },

    async pull(repo: GithubRepo, number: number): Promise<PullInfo> {
      const p = await request(
        Pull,
        repo.login,
        `/repos/${repo.owner}/${repo.name}/pulls/${number}`,
        operation(),
      );
      return {
        number: p.number,
        title: p.title,
        url: prUrl(repo, p.number),
        author: p.user?.login ?? "?",
        head: p.head.ref,
        headSha: p.head.sha,
        base: p.base.ref,
        open: p.state === "open",
        body: p.body ?? "",
        draft: p.draft ?? false,
        labels: p.labels.map((l) => l.name),
        changes:
          p.changed_files === undefined
            ? null
            : { files: p.changed_files, additions: p.additions ?? 0, deletions: p.deletions ?? 0 },
      };
    },

    // Asks for the review of the repo's own login on a PR. GitHub adds to the reviewers it
    // already has; it never replaces them. The PR list is read again on the next call.
    async requestReview(repo: GithubRepo, number: number): Promise<{ reviewer: string }> {
      invalidate();
      try {
        await request(
          Requested,
          repo.login,
          `/repos/${repo.owner}/${repo.name}/pulls/${number}/requested_reviewers`,
          operation(),
          { method: "POST", fields: [["reviewers[]", repo.login]] },
        );
      } catch (err) {
        // GitHub answers 422 when the login wrote the PR or cannot review in the repo.
        if (err instanceof ProviderError && err.status === 422)
          throw new ProviderError(
            "github",
            422,
            `GitHub 422 on ${repo.id}#${number}: GitHub refused a review request for ${repo.login} (the author, or a login without access to the repo, cannot be asked)`,
          );
        throw err;
      }
      invalidate();
      return { reviewer: repo.login };
    },

    // Everything said on a PR, oldest first. A review without text and with no verdict
    // (the wrapper of line comments) is left out; its line comments stand on their own.
    // ponytail: the first 100 of each kind; paginate when a PR has more.
    async discussion(
      repo: GithubRepo,
      number: number,
    ): Promise<{ comments: PullComment[]; truncated: boolean }> {
      const signal = operation();
      const base = `/repos/${repo.owner}/${repo.name}`;
      const [conversation, reviews, lines] = await Promise.all([
        request(
          IssueComments,
          repo.login,
          `${base}/issues/${number}/comments?per_page=100`,
          signal,
        ),
        request(Reviews, repo.login, `${base}/pulls/${number}/reviews?per_page=100`, signal),
        request(
          ReviewComments,
          repo.login,
          `${base}/pulls/${number}/comments?per_page=100`,
          signal,
        ),
      ]);
      const who = (u: z.infer<typeof Author>) => u?.login ?? "?";
      const all: PullComment[] = [
        ...conversation.map((c) => ({
          author: who(c.user),
          created: c.created_at,
          body: c.body ?? "",
        })),
        ...reviews
          .filter((r) => r.submitted_at && (r.body?.trim() || r.state !== "COMMENTED"))
          .map((r) => ({
            author: who(r.user),
            created: r.submitted_at ?? "",
            body: r.body ?? "",
            where: `review ${r.state.toLowerCase().replaceAll("_", " ")}`,
          })),
        ...lines.map((c) => ({
          author: who(c.user),
          created: c.created_at,
          body: c.body,
          where: `${c.path}:${c.line ?? c.original_line ?? "?"}`,
        })),
      ];
      return {
        comments: all.sort((a, b) => a.created.localeCompare(b.created)),
        truncated: [conversation, reviews, lines].some((items) => items.length >= 100),
      };
    },
  };
}

export type GithubClient = ReturnType<typeof githubClient>;
