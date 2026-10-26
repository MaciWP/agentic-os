# ADR 0001 — Stack

Status: accepted (2026-09-30). Versions from `npm view` on that date.

## Context

A single-user cockpit that runs on the developer's machine: Jira tickets, GitHub
PRs, Markdown notes, saved prompts and Claude Agent SDK runs. It must work on
real data from the first screen, be fast to drive from the keyboard, and be a
codebase an AI agent can change safely (one check command, typed boundaries,
mainstream libraries with good documentation).

## Decision

| Layer | Choice | Version |
|---|---|---|
| Form factor | Local web app, single origin `http://localhost:4317`, server bound to `127.0.0.1` | — |
| Runtime | Bun | 1.3.5 |
| HTTP + contract | Hono + Hono RPC (`hc<AppType>`) + zod | 4.13.12 / 4.6.5 |
| Streaming | SSE (`streamSSE`), `server.timeout(req, 0)`, 15 s heartbeat; cancel by POST | — |
| Database | `bun:sqlite`, versioned SQL in `migrations/`, FTS5 | built-in |
| Frontend | React + Vite + TanStack Router (code-based routes) + TanStack Query | 19.3 / 8.3 / 1.170 / 5.104 |
| UI | Tailwind 4 + shadcn/ui, Linear-like tokens | 4.3.3 |
| Editor | Plain textarea first; CodeMirror 6 later. Markdown stays the source | — |
| Code colours | Shiki, JavaScript regex engine (the CSP has no WASM), Dark+ (ADR 0014) | 4.5.0 |
| Agents | The harness CLIs (`claude`, `codex`, `grok`) in PTYs; the Agent SDK is removed (amendment below) | — |
| GitHub | REST through `gh api -i`, parsed with zod; gh's active account must be each repo's `login` | gh 2.95 |
| Jira | `fetch` + zod against `api.atlassian.com/ex/jira/{cloudId}`, OAuth 2.0 (3LO) | — |
| Secrets | macOS Keychain (`Bun.secrets`, `security` CLI fallback) | built-in |
| Quality | TypeScript 7, Biome, `bun test`, Playwright | 7.0.2 / 2.5 / 1.63 |

## Rejected

| Option | Why not |
|---|---|
| Tauri | Needs Rust for little gain on one machine |
| Electron | Memory cost for no extra capability |
| Next.js | SSR and server components add nothing to a local SPA |
| Svelte / Solid | Fewer examples for the AI; TS 7 cannot yet check Svelte templates |
| tRPC / oRPC | Hono RPC already gives end-to-end types |
| WebSocket | Agent output flows one way; SSE is simpler |
| Drizzle | About six tables and FTS5 in raw SQL. Upgrade trigger: more than 8 tables or joins across 3+ tables |
| BlockNote / TipTap | Lossy Markdown round-trip |

## Amendment (2026-10-06): gh makes the GitHub calls

The server used to read the token with `gh auth token --user <login>` and call the API
itself. Endpoint security software reported every lookup as a credential access attempt (a
non-gh process pulling a token out of gh's store). Now `gh api` makes each call, so the
token never leaves gh. Costs accepted: one gh process per request (the 30 s inbox cache
absorbs it), and gh has no per-call account, so a repo whose `login` is not gh's active
account is an error until `gh auth switch --user <login>`.

## Amendment (2026-10-08): no Agent SDK

No feature ran on `@anthropic-ai/claude-agent-sdk`; agents run as their CLIs in terminals and
consultations. The dependency, its policy module and its auth proof script are removed.

## Consequences

- Dependencies are added when their feature starts, not upfront.
- A 15-minute compatibility smoke (typed Hono call, migration, Tailwind build,
  `vite build`, browser launch) runs before feature work; TypeScript drops to 6
  if a tool needs the old compiler API.
- What an agent may do is decided in one table: see [0002](0002-agent-runs.md).
- Vendor docs for agents working on this repo: `https://hono.dev/llms.txt`,
  `https://bun.com/llms.txt`, `https://tanstack.com/llms.txt`,
  `https://ui.shadcn.com/llms.txt`, `https://code.claude.com/docs/llms.txt`.
