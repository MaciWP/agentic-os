# ADR 0013 — State ownership

Status: accepted (2026-10-08). Scope: every piece of state the app keeps, across the three
processes (server, PTY host, supervisor), the browser and the user's Keychain.

## Context

The architecture review (`data/evidence/architecture-history/15-architecture-review.md`)
found state with no clear owner: twelve web files reading and writing browser storage under
unprefixed names, module-level `let`s, and SQLite tables written from two processes. A piece
of state with two writers drifts; one with no stated owner gets a second writer by accident.

## Decision

1. **One owner per piece of state.** The owner is one module: the only code that writes it.
   Everything else reads through the owner's functions, or over HTTP when it lives in
   another process. The tables below name the owner; a new piece of state gets a row here
   in the same change.
2. **Server state is the truth; the browser holds caches and preferences.** Nothing kept
   only in the browser is data the user would miss: losing browser storage loses a
   preference or a pending retry, never a record.
3. **Browser storage goes through `web/storage.ts`**: each key declared once with a zod
   schema, an `aos.` name and a default; reads never throw. Module state in the browser
   lives in a `web/store.ts` store. `scripts/layers.test.ts` enforces both and lists the
   files not moved yet.
4. **Secrets live only in the Keychain**, through `server/secrets.ts` (CLAUDE.md rule 6).
   The PTY host never reaches it (`server/host/host.test.ts`).

## Server: SQLite (`data/agentic-os.db`)

Both the server (`server/index.ts` (`openDb`)) and the PTY host (`server/host/main.ts` (`openDb`)) open the
database. Only the server migrates; the host opens it in `"check"` mode and refuses a schema
with pending migrations (`server/db.ts` (`openDb`)). WAL with a 3 s busy timeout lets both write; the coordination
and workspace stores take each write as one `BEGIN IMMEDIATE` transaction.

| Table | Holds | Owner module | Process that writes |
|---|---|---|---|
| `schema_migrations` | Migrations applied | `server/db.ts` (`migrate`) | server |
| `connections` | Provider accounts (no tokens) | `server/features/jira/oauth.ts` | server |
| `terminal_sessions` | Every terminal launched and its last state | `server/features/terminals/pty.ts` | host |
| ↳ `session_id` column | The harness session a terminal resumes | `server/features/agents/state.ts` (`AgentTracker`) | server |
| `terminal_launch_requests` | Launch ledger: a retried request joins the first | `server/features/terminals/launch-requests.ts` | host |
| `memory_docs` | Index of Markdown docs, rebuilt from the files | `server/features/memory/store.ts` | server |
| `memory_fts` | Full-text index over `memory_docs` (FTS5, same rowid) | `server/features/memory/store.ts` | server |
| `agent_sources`, `agent_places`, `agent_usage`, `agent_events` | Transcript read offsets, places, model calls, harness events | `server/features/usage/ingest.ts` | server |
| `coordination_records`, `coordination_reservations`, `coordination_revision`, `coordination_audit` | Messages, consultations, file reservations, their revision and audit | `server/features/coordination/store.ts` | server and host (see below) |
| `workspace_state`, `workspace_requests` | Mesa membership and work blocks shared across devices, and its request ledger | `server/features/workspace/store.ts` | server |
| `objectives`, `terminal_objectives`, `session_objectives` | Tickets and goals worked on, each terminal's choice, the objective each agent session ran under | `server/features/objectives/store.ts` | server |

`server/backup.ts` copies the database before a migration (`server/db.ts` (`migrate`)) and, from the
`scripts/data.ts` CLI only, backs it up or marks terminals `lost` in a restored copy. It never
writes the live tables otherwise.

## Server and host: files on disk

`DATA_DIR` is `$AGENTIC_OS_DATA`, else `data/` (`data/dev/` in development;
`server/config-host.ts` (`DATA_DIR`)).

| Path | Holds | Owner (writer) |
|---|---|---|
| `data/config.json` | Settings | The user, by hand; the server rewrites only `repos` (`server/features/projects/places.ts` (`editRepos`)) |
| `data/agentic-os.db` (+ `-wal`, `-shm`) | The database above | `server/db.ts` (both processes write; only the server migrates) |
| `data/backups/pre-migration-*.sqlite` | Copy before a migration; only the last few kept | `server/db.ts` (`migrate`, `PRE_MIGRATION_KEEP`) |
| `data/backups/<ts>-<uuid>/` | Full backup | `server/backup.ts`, run by `scripts/data.ts` |
| `data/server.lock` | Single-instance lock of the server | `server/process-lock.ts` (`acquireProcessLock`) from `server/index.ts` |
| `data/pty-host.lock` | Single-instance lock of the host | `server/process-lock.ts` (`acquireProcessLock`) from `server/host/main.ts` |
| `data/pty-host.json` | Host port, token, pid, protocol (0600) | `server/host/files.ts` (`writeHostFile`), host only; the server reads it |
| `data/pty-host.log` | Host output | Opened by the server when it spawns the host (`server/host/launch.ts` (`connectHost`)) |
| `data/server.log` | Server and supervisor output | `scripts/start-agentic-os.command` (shell redirect) |
| `data/supervisor.pid` | Supervisor pid | `scripts/supervise.ts` (`supervise`) |
| `data/workboard-sessions.json` | Workboard sessions and answers | `server/features/workboard/store.ts` (`WorkboardStore`) |
| `data/inbox-gmail.json`, `data/inbox-outlook.json` | Last inbox read (Gmail with its history ids, Outlook with its stamp), answered at once after a restart (0600) | `server/json-file.ts` (`fileCopy`) from `server/features/google/client.ts` and `server/features/mac/outlook.ts` |
| `data/notes/`, `data/memory/`, `data/prompts/` | The app's Markdown docs (the truth for `memory_docs`) | `server/features/memory/store.ts`; the user and agents may also edit the files |
| `data/recovery/<uuid>/` | A copy of a file before a destructive action, kept 30 days | `server/recovery.ts` (`saveRecovery`) |
| `data/pastes/` | Pasted images | `server/features/images/store.ts` (`saveImage`) |
| `data/kickoff/<KEY>/<mode>.md` | Ticket context for a kickoff agent | `server/features/kickoff/run.ts` (`Kickoffs`) |
| `data/consultations/<id>/` | Consultation snapshot, patch and output | `server/features/coordination/snapshot.ts` (server) and `server/features/coordination/adapters.ts` (`executor`, host) |
| Voice model folder (`config.voice.model`, an absolute path) | Speech model files | The user, by hand; the server only reads it (`server/config.ts` (`voice`)) |
| `dist/` (+ `dist.next`, `dist.prev`, `dist.lock`) | Built web app | `scripts/refresh.ts` |

## Keychain

`atlassian.client_id`, `atlassian.client_secret`, `atlassian.tokens`, `claude.oauth_token`,
`anthropic.api_key`. Owner: `server/secrets.ts` (`setSecret` called only from
`server/oauth.ts` (`saveBundle`, shared by every OAuth provider) and the `scripts/secrets-set.ts` CLI).

## Server memory

Caches and in-flight work; all of it is rebuilt from the tables, files or providers after a
restart.

| State | Owner |
|---|---|
| Event subscribers and pending topics | `server/features/events/bus.ts` |
| Jira ticket and board lists (60 s) | `server/features/jira/routes.ts` |
| OAuth `state` values, token refresh in flight | `server/features/jira/oauth.ts` |
| GitHub login and PR inbox cache | `server/features/github/prs.ts` |
| WebSocket attach tokens | `server/features/terminals/ws-guard.ts` |
| Kickoff runs | `server/features/kickoff/run.ts` |
| Env CLI jobs and their output | `server/features/envs/jobs.ts` |
| Per-terminal agent state | `server/features/agents/state.ts` |
| Sockets to the host | `server/features/terminals/host-client.ts` |
| Usage ingest progress | `server/features/usage/ingest.ts` |
| Doc walk and per-doc write locks | `server/features/memory/store.ts` |
| Per-file write queue of the code tiles | `server/features/code/write.ts` (`writeCode`) |
| Per-recipient message delivery chain | `server/features/coordination/messages.ts` |
| Repos being synced | `server/features/git/sync.ts` |
| Voice engine worker and queue | `server/features/voice/engine.ts` |
| Clipboard watcher | `server/features/images/clipboard-watch.ts` |
| `caffeinate` holders | `server/features/system/keep-awake.ts` |
| Pending restart | `server/restart.ts` |

## PTY host memory

The host outlives server restarts; terminals live here, and the host's record of them is the
`terminal_sessions` table.

| State | Owner |
|---|---|
| Live terminals: process, screen, waiters | `server/features/terminals/pty.ts` (`TerminalManager`) |
| Screen buffer and write queue per terminal | `server/features/terminals/screen.ts` |
| Launches in flight | `server/features/terminals/launch-requests.ts` |
| Output activity per terminal | `server/features/terminals/activity.ts` |
| Running consultations | `server/features/coordination/runner.ts` |
| Host token, connected servers, control sockets | `server/host/main.ts`, `server/host/app.ts` |
| Config read and login environment cache | `server/host/host.ts`, `server/features/terminals/env.ts` |

## Browser storage

Every key goes through `web/storage.ts` (`storageKey` / `storageFamily`, zod schema, `aos.`
prefix); `scripts/layers.test.ts` lists the files not moved yet. Browser storage is a
per-browser cache of the user's choices: losing it loses a preference, never data.

| Key | Area | Holds | Owner (only writer) |
|---|---|---|---|
| `aos.tree.open` | local | Open sections and tree nodes | `web/ui.tsx` (`useOpen`) |
| `aos.git.diff` | local | Unified or split diff | `web/features/git/diff-view.tsx` |
| `aos.diff-notes:<location>` | local | Notes on a checkout's diff, sent or not; sent ones drop after 7 days, 200 at most | `web/features/git/notes.ts` |
| `aos.code.file:<location>` | local | The file a checkout's code tile showed last, and its line | `web/features/code/open.ts` |
| `aos.mesas` | local | This browser's Mesas: layout, focus, tab order, members as last synced | `web/features/terminals/mesas.ts` |
| `aos.mesas.before-sync` | local | One copy of `aos.mesas` taken before the first server sync | `web/features/terminals/workspace-sync.tsx` |
| `aos.grid`, `aos.grid.layout` | local | Pre-Mesa grid, read once into `aos.mesas`; never written | none (read by `mesas.ts`, `grid-state.ts`) |
| `aos.mesa.active` | session | Active Mesa of this tab | `web/features/terminals/mesas.ts` |
| `aos.machine` | session | Machine this tab works on; a worker's tab keeps every other key under `aos.@<machine>.` | `web/machine.ts` |
| `aos.chunk-reload` | session | When this tab last reloaded itself after a rebuild removed a chunk | `web/main.tsx` |
| `aos.rail.source` | local | The tab under the Mesas in the rail: projects, tickets or PRs | `web/features/projects/rail-sources.tsx` |
| `aos.mesa.view` | local | The Mesa page's last view: terminals, mosaic or canvas | `web/features/terminals/overview.tsx` |
| `aos.projects.picked` | local | Row of the projects tree marked for the bar over it to launch in | `web/features/projects/tree-node.tsx` |
| `aos.rail-width:<rail>` | local | Rail width (was `rail-width:<rail>`) | `web/features/terminals/mesa-rail.tsx` |
| `aos.launch:<key>` | session | Request id of a launch in flight, so a retry joins it | `web/features/terminals/queries.ts` (removed by it; listed by `launch-recovery.tsx`) |
| `aos.terminal.draft:<id>` | local | Text in the phone composer of a terminal, kept across reloads | `web/features/terminals/composer.tsx` |
| `aos.message.draft:<id>`, `aos.message.request:<id>` | local | Unsent message to a terminal and its request id (was `…draft:<id>:request`) | `web/features/terminals/mobile.tsx` |
| `aos.terminals.waiting` | session | Terminals that wait for the user unseen, so a reload or «Reiniciar todo» keeps them | `web/features/terminals/attention.tsx` |
| `aos.chime.volume` | local | Volume of the alert chimes, 0 to 1 | `web/chime.ts` |
| `aos.bring-mode` | local | «Traer» mode (was `bring-mode`) | `web/features/terminals/bring.ts` |
| `aos.terminal-touch-view` | local | Touch view: reader or terminal (was `terminal-touch-view`) | `web/features/terminals/mobile.tsx` |
| `aos.terminal-font-size` | local | Touch font size (was `terminal-font-size`) | `web/features/terminals/mobile.tsx` |
| `aos.terminal-renderer` | local | Renderer choice (Auto/GPU/CPU) (was `terminal-renderer`) | `web/features/terminals/renderer.ts` |
| `aos.inicio.mail.gmail`, `aos.inicio.mail.outlook` | local | Last inbox Inicio read, drawn at once on a reopen and read again behind it | `web/features/today/queries.ts` |

## TanStack Query cache

One `QueryClient` (`web/main.tsx`). It is a cache of server reads, never a source: every
entry is written by its query function from an API answer. It is refreshed in three ways:
the query's own refetch; `web/events.ts` (`useServerEvents`), which invalidates a whole topic (`[topic]`) when
the server's event stream says it changed; and a mutation's `onSuccess`, which writes the
answer it got back (`setQueryData`) or invalidates its keys. The key roots and their reading
modules: `terminals`, `workspace`, `images` (terminals); `coordination`; `memory`; `projects`,
`envjobs`, `envs`, `envpreview`; git (`GIT`); `code`; `tickets`, `ticket`, `kickoff`; `files`;
`agents`, `agents-activity`, `conversation`; `usage`, `usage-jira`; `system`; `prs`; `voice`;
`connections`; `access`.

## Module stores (browser memory)

A module keeps state in a `web/store.ts` store (`createStore`), never in a loose `let` nor in a
module-level `Map` or `Set`; `scripts/layers.test.ts` names the few caches and registries no
view reads (`MODULE_CACHES`).

| State | Owner (only writer) |
|---|---|
| Alerts (chime, system notification, «Siguiente») | `web/features/alerts/alerts.ts` (`raise`, `dismiss`, `dismissTerminals`) |
| Audio context, last chime and volume | `web/chime.ts` |
| Spinner step, its timer and the times the page became visible | `web/motion.ts` (`spinRef`, `useRise`) |
| Unsaved note text while its editor is closed | `web/features/memory/editor.tsx` (`hasDraft`) |
| Launch ids not yet confirmed, in memory beside `aos.launch:` | `web/features/terminals/queries.ts` (`createTerminal`, `forgetLaunch`) |
| A change to a phone composer draft, for the open composer | `web/features/terminals/composer.tsx` (`setDraft`) |
| Notes on each checkout's diff, mirrored to `aos.diff-notes:` | `web/features/git/notes.ts` (`addNote`, `removeNote`, `clearSent`, `sendNotes`) |
| Images in each terminal's Claude draft, as its socket last said | `web/features/terminals/draft-strip.tsx` (`publishDrafts`) |
| File and line each code tile shows | `web/features/code/open.ts` (`openIn`) |
| Highlight worker and the texts waiting for its colours (a `const` record: nothing renders from it) | `web/features/code/highlight.ts` (`paint`) |
| Unsaved code editor text while its file is closed (drafts) | `web/features/code/editor.tsx` (`keepDraft`) |
| Monaco's theme and the grammars it has registered (a `const` record: nothing renders from it) | `web/features/code/monaco.ts` (`prepare`) |
| Dictation in progress, audio graph | `web/features/voice/capture.ts` |
| Dictations on their way to text | `web/features/voice/use-dictation.ts` (`createPendingStore`) |
| Terminals waiting for the user | `web/features/terminals/attention.tsx` |
| Mesas workspace snapshot | `web/features/terminals/mesas.ts` |
| Renderer choice and WebGL addons | `web/features/terminals/renderer.ts` |
| Workspace sync state and the commands not yet confirmed | `web/features/terminals/workspace-sync.tsx` (`workspaceSync`) |
| The Lienzo's camera while the page lives, so «Volver» finds it where it was | `web/features/terminals/canvas.tsx` (`camera`) |

## Consequences

- A reviewer can answer "who writes this?" from one table, and `scripts/layers.test.ts`
  fails when a web file reaches browser storage, declares a key without `aos.`, or keeps
  module state in a loose `let`.
- Known exceptions, kept on purpose or pending:
  - The coordination tables and `data/consultations/` are written from both processes: the
    server records requests, the host runs consultations. One module owns the tables
    (`CoordinationStore`), each write is one `BEGIN IMMEDIATE` transaction that bumps
    `coordination_revision`.
  - `terminal_sessions` is split by column: the host owns the row and its state
    (`pty.ts`); the server writes only `session_id` (`server/features/agents/state.ts` (`AgentTracker`)).
  - The old unprefixed browser keys (`bring-mode`, `terminal-*`, `rail-width:*`) and
    `aos.message.draft:<id>:request` are read once under their old name and moved to the
    new one (`legacy` in `web/storage.ts`), so no setting is lost.
  - `data/recovery/` keeps a copy 30 days (`RECOVERY_KEEP_MS`); the next save prunes older ones.
  - `agent_usage` and `agent_events` keep 400 days (`USAGE_KEEP_MS`); each usage read prunes them,
    and the `agent_places` neither cites any more.
  - `data/kickoff/` keeps a ticket's context 30 days (`KICKOFF_KEEP_MS`); each round prunes older
    files and the folders they empty.
  - `data/server.log` and `data/pty-host.log` rotate at 10 MB, keeping one `.1` copy
    (`rotate` in `server/log.ts`, run by `serverRoot` in `server/deps.ts`).
