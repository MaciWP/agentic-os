#!/usr/bin/env bun
// The delivery side of the agent setup: what the user's own PRs did in a window, per ticket,
// from GitHub, the Claude transcripts and the app's usage report (ADR 0008). Usage says what the
// agents spent; this says what shipped for it, so a change to the setup is judged by both.
//
//   bun scripts/delivery.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--projects <dir>]
//
// Defaults: the last 90 days and ~/.claude/projects. JSON on stdout, errors on stderr.
// A source that fails is named in `errors`: transcripts and usage numbers are then null, never
// zero, and a repo GitHub could not read is left out of the counts.
// Cycle is PR opened to merged. Reviews and review comments count other people's only.
// A PR is reverted when a PR opened after it is titled `Revert "<its title>"` or names `#<n>`.
// `--no-verify` counts `git commit … --no-verify` runs in Claude sessions on a ticket branch.
// Cost per merged PR: the cost of the tickets with a merged PR over their merged PRs.
// ponytail: GitHub search stops at 1000 PRs per query, and commits are read from Claude
// transcripts only; page by month and add Codex/Grok when either reaches that.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { type GithubRepo, loadConfig, onGithub } from "../server/config.ts";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
const GH_TIMEOUT_MS = 30_000;
// The usage report ingests the transcripts first when its last read is old.
const USAGE_TIMEOUT_MS = 120_000;
const KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NO_VERIFY = /\bgit\b[^\n]*\bcommit\b[^\n]*--no-verify/;

export type Pr = {
  repo: string;
  number: number;
  title: string;
  ticket: string | null;
  created: string;
  merged: string | null;
  closed: string | null;
  reviews: number;
  reviewComments: number;
  additions: number;
  deletions: number;
  reverted: boolean;
};

const Search = z.object({
  total_count: z.number(),
  items: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      created_at: z.string(),
      closed_at: z.string().nullable(),
    }),
  ),
});
const Login = z.object({ login: z.string() }).nullable();
const Pull = z.object({
  head: z.object({ ref: z.string() }),
  user: Login,
  additions: z.number(),
  deletions: z.number(),
  merged_at: z.string().nullable(),
});
const ByUser = z.array(z.object({ user: Login, state: z.string().optional() }));
const Usage = z.object({
  total: z.object({ cost: z.number().nullable() }),
  byTicket: z.array(z.object({ key: z.string(), cost: z.number().nullable() })),
});
type Usage = z.infer<typeof Usage>;

// Whether one of the titles reverts the PR.
export function revertedBy(pr: { number: number; title: string }, titles: string[]): boolean {
  const named = new RegExp(`#${pr.number}\\b`);
  return titles.some((t) => /^revert\b/i.test(t) && (t.includes(`"${pr.title}"`) || named.test(t)));
}

// The ticket of each `git commit --no-verify` on one transcript line in the window ("" when its
// branch names none).
export function noVerifyIn(line: string, since: string, until: string): string[] {
  if (!line.includes("--no-verify")) return [];
  let j: { type?: unknown; timestamp?: unknown; gitBranch?: unknown; message?: unknown };
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  const at = typeof j.timestamp === "string" ? j.timestamp.slice(0, 10) : "";
  if (j.type !== "assistant" || at < since || at > until) return [];
  const content = (j.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const ticket = (typeof j.gitBranch === "string" && KEY.exec(j.gitBranch)?.[0]) || "";
  return content
    .filter((b) => b?.type === "tool_use" && b.name === "Bash")
    .filter((b) => NO_VERIFY.test(String(b.input?.command ?? "")))
    .map(() => ticket);
}

// The value at a share of the sorted values, nearest rank; null for none.
function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null;
}
const round = (n: number | null, digits: number) =>
  n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits;
const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
// The Monday of the UTC week an instant falls in.
function weekOf(at: string): string {
  const d = new Date(at.slice(0, 10));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function report(input: {
  since: string;
  until: string;
  prs: Pr[];
  noVerify: string[] | null;
  usage: Usage | null;
  errors: string[];
}) {
  const { prs, usage, noVerify } = input;
  const merged = prs.filter((p) => p.merged);
  const cycles = (list: Pr[]) =>
    list.flatMap((p) => (p.merged ? [hours(p.created, p.merged)] : []));
  const cost = new Map(usage?.byTicket.map((t) => [t.key, t.cost ?? 0]) ?? []);
  const costOf = (ticket: string) => (usage ? (cost.get(ticket) ?? 0) : null);

  const weeks = new Map<string, { opened: number; merged: number }>();
  const week = (at: string) => {
    const w = weekOf(at);
    const row = weeks.get(w) ?? { opened: 0, merged: 0 };
    weeks.set(w, row);
    return row;
  };
  for (const p of prs) {
    week(p.created).opened++;
    if (p.merged) week(p.merged).merged++;
  }

  const tickets = [...new Set(prs.flatMap((p) => (p.ticket ? [p.ticket] : [])))];
  const byTicket = tickets
    .map((ticket) => {
      const own = prs.filter((p) => p.ticket === ticket);
      return {
        ticket,
        prs: own.length,
        merged: own.filter((p) => p.merged).length,
        cycleHours: round(quantile(cycles(own), 0.5), 1),
        reviews: own.reduce((s, p) => s + p.reviews, 0),
        reviewComments: own.reduce((s, p) => s + p.reviewComments, 0),
        reverted: own.filter((p) => p.reverted).length,
        noVerify: noVerify ? noVerify.filter((t) => t === ticket).length : null,
        cost: round(costOf(ticket), 2),
      };
    })
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.prs - a.prs);

  const shipped = byTicket.filter((t) => t.merged > 0);
  const shippedCost = shipped.reduce((s, t) => s + (t.cost ?? 0), 0);
  const shippedPrs = shipped.reduce((s, t) => s + t.merged, 0);
  const ticketsCost = usage ? tickets.reduce((s, t) => s + (cost.get(t) ?? 0), 0) : null;
  const total = usage?.total.cost ?? null;
  return {
    window: { since: input.since, until: input.until },
    summary: {
      opened: prs.length,
      merged: merged.length,
      open: prs.filter((p) => !p.closed).length,
      closedUnmerged: prs.filter((p) => p.closed && !p.merged).length,
      cycleHours: {
        median: round(quantile(cycles(prs), 0.5), 1),
        p90: round(quantile(cycles(prs), 0.9), 1),
      },
      reviewsPerPr: quantile(
        prs.map((p) => p.reviews),
        0.5,
      ),
      reviewCommentsPerPr: quantile(
        prs.map((p) => p.reviewComments),
        0.5,
      ),
      reverted: prs.filter((p) => p.reverted).length,
      noVerify: noVerify ? noVerify.filter(Boolean).length : null,
      noVerifyOffTicket: noVerify ? noVerify.filter((t) => !t).length : null,
      cost: {
        total: round(total, 2),
        tickets: round(ticketsCost, 2),
        outsideTickets: round(
          total === null || ticketsCost === null ? null : total - ticketsCost,
          2,
        ),
        perMergedPr: round(usage && shippedPrs ? shippedCost / shippedPrs : null, 2),
      },
    },
    byWeek: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([w, r]) => ({ week: w, ...r })),
    byTicket,
    prs,
    errors: input.errors,
  };
}

async function gh<S extends z.ZodType>(bin: string, path: string, schema: S): Promise<z.infer<S>> {
  const p = Bun.spawn([bin, "api", "--hostname", "github.com", path], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: GH_TIMEOUT_MS,
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`gh api ${path.split("?")[0]} exited ${code}`);
  return schema.parse(JSON.parse(out));
}

async function search(bin: string, q: string) {
  const items: z.infer<typeof Search>["items"] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh(
      bin,
      `/search/issues?per_page=100&page=${page}&q=${encodeURIComponent(q)}`,
      Search,
    );
    items.push(...r.items);
    if (items.length >= r.total_count || r.items.length < 100) break;
  }
  return items;
}

async function prsOf(bin: string, repo: GithubRepo, since: string, until: string): Promise<Pr[]> {
  const slug = `${repo.owner}/${repo.name}`;
  const [mine, reverts] = await Promise.all([
    search(bin, `is:pr repo:${slug} author:${repo.login} created:${since}..${until}`),
    search(bin, `is:pr repo:${slug} in:title revert created:>=${since}`),
  ]);
  const titles = reverts.map((r) => r.title);
  const others = (list: z.infer<typeof ByUser>, author: string) =>
    list.filter((x) => x.user && x.user.login !== author && x.state !== "PENDING").length;
  return Promise.all(
    mine.map(async (item) => {
      const base = `/repos/${slug}/pulls/${item.number}`;
      const [pull, reviews, comments] = await Promise.all([
        gh(bin, base, Pull),
        gh(bin, `${base}/reviews?per_page=100`, ByUser),
        gh(bin, `${base}/comments?per_page=100`, ByUser),
      ]);
      const author = pull.user?.login ?? repo.login;
      return {
        repo: slug,
        number: item.number,
        title: item.title,
        ticket: KEY.exec(pull.head.ref)?.[0] ?? KEY.exec(item.title)?.[0] ?? null,
        created: item.created_at,
        merged: pull.merged_at,
        closed: item.closed_at,
        reviews: others(reviews, author),
        reviewComments: others(comments, author),
        additions: pull.additions,
        deletions: pull.deletions,
        reverted: revertedBy(item, titles),
      };
    }),
  );
}

// Every `--no-verify` commit in the Claude transcripts touched in the window. The harness's own
// test runs (`-private-*` folders) are not the user's work.
function noVerifyCommits(projects: string, since: string, until: string): string[] {
  const from = Date.parse(since);
  const hits: string[] = [];
  for (const dir of readdirSync(projects)) {
    if (dir.startsWith("-private-")) continue;
    const path = join(projects, dir);
    if (!statSync(path).isDirectory()) continue;
    for (const file of readdirSync(path)) {
      const full = join(path, file);
      if (!file.endsWith(".jsonl") || statSync(full).mtimeMs < from) continue;
      for (const line of readFileSync(full, "utf8").split("\n"))
        hits.push(...noVerifyIn(line, since, until));
    }
  }
  return hits;
}

async function usageOf(since: string, until: string): Promise<Usage> {
  const base = process.env.AOS_URL ?? "http://localhost:4317";
  const r = await fetch(`${base}/api/usage?from=${since}&to=${until}`, {
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`usage report answered ${r.status}`);
  return Usage.parse(await r.json());
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      since: { type: "string" },
      until: { type: "string" },
      projects: { type: "string" },
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  const until = values.until ?? today;
  const since =
    values.since ?? new Date(Date.parse(until) - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  if (!DAY.test(since) || !DAY.test(until) || since > until) {
    process.stderr.write("usage: delivery.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD]\n");
    process.exit(2);
  }
  const config = loadConfig();
  const bin = config.github.bin ?? "gh";
  const errors: string[] = [];
  const prs: Pr[] = [];
  for (const repo of config.repos.filter(onGithub)) {
    try {
      prs.push(...(await prsOf(bin, repo, since, until)));
    } catch (err) {
      errors.push(`github ${repo.owner}/${repo.name}: ${message(err)}`);
    }
  }
  let noVerify: string[] | null = null;
  try {
    noVerify = noVerifyCommits(
      values.projects ?? join(homedir(), ".claude", "projects"),
      since,
      until,
    );
  } catch (err) {
    errors.push(`transcripts: ${message(err)}`);
  }
  const usage = await usageOf(since, until).catch((err) => {
    errors.push(`usage: ${message(err)}`);
    return null;
  });
  for (const e of errors) process.stderr.write(`${e}\n`);
  process.stdout.write(
    `${JSON.stringify(report({ since, until, prs, noVerify, usage, errors }), null, 2)}\n`,
  );
}
