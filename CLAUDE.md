# Agentic OS

Local, single-user cockpit: Jira tickets, GitHub PRs, Markdown notes, saved
prompts, agent terminals and read-only consultations. Stack and reasons:
[docs/adr/0001-stack.md](docs/adr/0001-stack.md).
Private local context, when present: docs/private/context/user-profile.md.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Server on `127.0.0.1:4317` + Vite dev server with `/api` proxied. The user's call only; see "One server" |
| `bun run build` | Builds the SPA into `dist/` in place; sessions use `refresh` |
| `bun run start` | Production-like single origin on `http://localhost:4317` |
| `bun run check` | Types + Biome + unit tests. Must be green before any "done" |
| `bun run e2e` | Playwright against the real running server |
| `bun run refresh` | Rebuilds `dist/` for the user's server in one step (no restart needed) |
| `bun run e2e:isolated <files> --project main` | Playwright on the shared throwaway server (4318) |
| `bin/aos trace health` | Before and after a change: new errors, p95 regressions against the last 7 days (says when the baseline is too short), heaviest routes, time under no span, event-loop lag and disk. On a 5xx or a slow screen: `errors --since 15m`, then `bin/aos trace <id>` for the waterfall (waits on other traces, uninstrumented gaps, serial calls). `slow [--by total]` ranks routes and outside calls; `full [minutes]` stores every request while you test. Reads `data/telemetry.db`, also with the server down |

## One server

The app lives at **http://agentic-os.localhost:4317**: the user's own server, in production
mode, serving `dist/`. Every session works in this same tree, so there is one server for all
of them.

- **Never start a server or Vite** (`bun server/index.ts`, `bun run dev`, `vite`) from a session.
- **To show the user a change**, run `bun run refresh`. Do it when the user asks, or when the
  change is done and its checks pass. Never run a raw `vite build` into `dist/`.
- **e2e** only through `bun run e2e:isolated`. It builds into `data/e2e/`, runs one session
  at a time behind a lock, and stops its server and PTY host at the end. Never run e2e
  against 4317: it creates and stops real terminals.
- **Restart 4317** only when server code changed and the user agreed: stop the server
  (`kill $(lsof -nP -tiTCP:4317 -sTCP:LISTEN)`) and its supervisor starts the current code at
  once. Never start a second one by hand while `data/supervisor.pid` names a live supervisor;
  without one, use `NODE_ENV=production bun server/index.ts`. Terminals survive it, because
  they live in the PTY host. That host builds terminal argv and is kept while terminals run, so
  a change to what it imports (launch flags, env) needs both restarted: **Reiniciar todo** in
  the system panel (from any device, `POST /api/system/restart`), or
  `~/Applications/start-agentic-os.command` (a link to `scripts/start-agentic-os.command`),
  which uses the same route. A session runs inside the host, so it never asks for that
  restart itself: the user presses it. The server stays under `scripts/supervise.ts`, which
  also restarts it after a crash. Details: [docs/remote-workspace.md](docs/remote-workspace.md).

## Layout

- `server/` — Hono app; `server/features/<feature>/` holds routes, client, logic and tests.
- `shared/contracts.ts` — zod schemas shared by client and server.
- `web/` — React SPA; `web/features/<feature>/` mirrors the server.
- `migrations/` — numbered SQL files, applied at startup.
- `data/` — gitignored: `config.json`, SQLite DB, notes folder default.

## Rules

1. **Real data only.** No mock data source in shipped code; fakes live inside unit tests.
2. **zod at every boundary**: HTTP input, Jira/GitHub responses, config, DB rows read as JSON.
3. **Provider errors are errors.** Never render a failed fetch as an empty list.
4. **Tracker values unchanged.** Show Jira status names and fields as Jira returns them.
5. **Mutating routes** pass `local-guard` (Host, Origin, JSON Content-Type).
6. **Secrets** only through `server/secrets.ts` (Keychain). Never log tokens; never put them in `data/`.
7. **Agent permissions** come only from `PERMISSIONS` in `shared/harness-capabilities.ts` ([ADR 0002](docs/adr/0002-agent-runs.md)). Never widen a consultation's flags or environment.
8. **Subprocesses** use argv arrays (`Bun.spawn([...])`), never a shell string.
9. **No company data in git.** Project keys, field ids, repos and sites live in `data/config.json`.
10. English in code and docs; tests next to the code they test (`*.test.ts`).
11. **Every API route** is classified `remote` or `desktop` in `server/remote-routes.ts`; an unclassified one is refused remotely and fails `check`.

## Vendor docs

`https://hono.dev/llms.txt` · `https://bun.com/llms.txt` · `https://tanstack.com/llms.txt` ·
`https://ui.shadcn.com/llms.txt` · `https://code.claude.com/docs/llms.txt`
