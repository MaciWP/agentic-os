# ADR 0003 — In-app terminals

Status: accepted (2026-10-01). Amended 2026-10-05 by ADR 0008: lost agents are
resumed, the name is kept with the row, and agents show their harness's state.

## Context

Agents must work on a ticket with full Bash inside a worktree, with the user's
own harness (Claude Code, Codex, Grok) and its permission prompts and hooks.
A write-capable SDK agent cannot be confined: a `PreToolUse` hook does not stop
absolute paths, subshells or network access, and it would rebuild what the
harness already does. ADR 0002 stays as it is for read-only runs.

Bun 1.3.5 ships a native PTY (`Bun.spawn({ terminal })`), so no native addon is
needed. An external terminal multiplexer is not used: the app owns its terminals.

## Decision

- **What runs.** The browser sends a harness id and a location id, never a path
  or a command. The server maps the harness to a fixed argv with an absolute
  binary from config (`terminals.bins`), and resolves the location to a
  directory with `realpath`. The location `scratch` («Carpeta libre»,
  `terminals.scratch`) is a folder about no project, created on its first launch
  (2026-10-13). The page never sends a prompt of its own; `aos` may
  (ADR 0004). Every prompt is one argv element with no leading `-`, no NUL, at
  most 16 KB.
- **Environment.** The user's login environment, read once at host start from an
  empty environment (`zsh -lic`, then `env -0` after a marker). Session and app
  variables (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `ORCA_*`,
  `AGENTIC_OS_*`, `NODE_ENV`) are stripped; `SSH_AUTH_SOCK` passes through;
  `TERM`, `COLORTERM` and a UTF-8 `LANG` are set. ADR 0002's isolated config is
  never applied here: the harness loads the user's normal config and hooks.
- **Transport.** One WebSocket per window. Browsers apply no CORS to
  WebSockets, so the upgrade needs an exact Host and an exact Origin. The dev
  origin is accepted only outside production, here and in the HTTP guard. A guarded POST issues a one-use token
  (32 random bytes, 30 s, bound to terminal and Origin) that must be the first
  message; until then the socket receives nothing and its input is ignored.
  Live output goes as binary frames; control messages as JSON text.
- **Reattach.** A server-side `@xterm/headless` keeps each screen (5 000 lines).
  Output, resize and attach run in one serial queue per terminal; an attach
  serializes the screen at that point and forwards everything after it, so a
  new window has no gaps and no duplicates. A splitter holds back a trailing
  incomplete escape sequence or UTF-8 character until it completes, with no
  timer; only a sequence longer than 1 MB is released incomplete. The
  serializer does not restore the scroll region or a hidden cursor, so the
  snapshot appends both from the headless state (private fields of the pinned
  `@xterm/headless` version, guarded by type checks and a test).
- **Bounds.** One client per terminal. The host decides who holds it: an
  attach with `take` displaces the holder (4001), one without is answered
  `busy` (4409) and the holder stays. The browser sends `take` only for an
  explicit open (a popout, "Traer aquí") and keeps it until that attach lands;
  reconnects never take, and a view told busy or displaced never re-attaches
  by itself. A client with
  over 4 MB of live output buffered is dropped and reattaches; over 16 MB queued
  resets the screen (after the write being parsed) and marks the terminal
  overflowed; at most 12 running; resize clamped to 20–500 × 5–200 on both
  ends (`shared/terminals.ts`); input messages at most 64 KB. The snapshot does
  not count toward the 4 MB.
- **Lifecycle.** Stop sends SIGHUP to the process group, SIGKILL after 5 s,
  even when the leader has already exited. The exit is reported once the
  process has exited and the PTY reached EOF (at most 1 s later, since
  background jobs can hold it open). Exit code and signal are recorded in
  `terminal_sessions`. The PTY host's shutdown stops every terminal and leaves
  their rows running; rows still running when a host starts become `lost`, and
  the agents among them are resumed (ADR 0008). A server restart touches neither.
- **Name and folder.** A terminal may carry a name the user gives it from the
  header (`POST /api/terminals/:id/name`, guarded): trimmed, at most 40
  characters, no control or format characters (a bidi override would make one
  name read as another), empty clears it. The name wins wherever the terminal
  is named; its kind stays in the chip's `title` and in the palette's hint, so
  a search for "shell" still finds it. It is kept in `terminal_sessions.name` (ADR 0008), so a resumed agent has it
  back; the host's list drops it when an ended terminal is evicted past the 24
  kept. "Abrir
  carpeta" (`POST /api/terminals/:id/open-folder`, guarded) runs
  `[terminals.editor, cwd]`: the editor is an absolute path from config with no
  default, the cwd is the one the host recorded for that terminal id, and the
  body is ignored, so the page never names a path or a command. No editor in
  the profile disables the button with the reason; a cwd that no longer exists
  is a 409.
- **PTY host.** Terminals live in a separate process (`server/host/main.ts`),
  started detached by the server (its own session, so Ctrl+C on the server
  never reaches it) and reused by the next server. One host per data dir,
  held by `pty-host.lock` (`O_EXCL`, cleared once if its pid is no longer a
  host). It listens on 127.0.0.1, port 0, and writes `{port, token, pid,
  protocol}` to `pty-host.json` (tmp + rename, mode 0600). Every request needs
  the token (32 random bytes per host start, compared in constant time), and
  any request with an `Origin` header is refused, so no web page can reach it;
  the token never enters a PTY environment. The server proxies each window
  through one host WebSocket: the host's close codes pass through, and the
  server applies the slow-window rule against the browser's own buffer. When
  the host cannot be reached the window is closed with 4503 and retries (0.5 s
  to 5 s, 10 tries, the attach token included); HTTP routes answer 503 and the
  next call starts a new host. A host with another `protocol` is replaced only
  when it runs nothing; otherwise routes answer 503 naming its pid. The host
  re-reads `config.json` when it changes, and exits after 30 s with no server
  connected and nothing running. Only the host loads `@xterm/headless`.
- **Host build.** The server hashes the host's relative import graph plus
  `bun.lock` (`hostBuild`) and passes it as `AOS_HOST_BUILD`; the host echoes it
  in `pty-host.json` and `/health`. A host is reused only with the same
  protocol and build. One of another build is replaced when it runs nothing;
  while it runs terminals it is kept (it speaks this protocol) with a warning in
  the server log, and the first restart that finds it idle replaces it. An older
  protocol with terminals running is refused, never killed.
- **Activity.** Each terminal is `busy` or `idle` by its output over the last
  5 s against a per-harness threshold (shell and env 0 bytes, claude and codex
  1024; grok untracked, `activity: null`, because it redraws tens of KB while it
  waits). A state holds at least 5 s, redraws are muted for 1 s after attach,
  resize and typed keys, and only a flip publishes a change, so an idle app
  sends nothing. A long silent command (`sleep 60`) reads as idle. A running
  agent whose harness state is known shows that state instead (ADR 0008).
- **Change events.** The dashboard does not poll. The host sends `changed` on
  its control socket whenever the terminal list may have changed (start,
  attach, detach, overflow, exit, remove); the server also treats the control
  socket opening or closing as a change. `GET /api/events` (SSE) sends only
  the topic (`terminals`, `sessions`, `tickets`, `projects` from ADR 0005) and
  the page reads that list again through its usual query; every time the stream
  opens (the first time included) it reads all of them, so nothing that changed
  before the stream existed is missed. That costs one extra read of each list
  on page load.
  Sessions (30 s) and tickets (5 min) are checked by the server, once for all
  tabs and only while a dashboard is open, and published only when the result
  changes. A watcher's first load is its baseline: for tickets it may come from
  the cache below, so it matches what the page has just read; later checks
  skip the cache.
  Terminal windows hold no stream: a browser shares six HTTP/1.1 connections
  per host across every tab, and one held stream per window would stall the
  app at six.
- **Ticket cache.** A successful ticket search is kept 60 s. Every read joins
  a search already running, so a page read during the watcher's check waits
  for that search instead of starting another. `?fresh=1` (the "Actualizar"
  and "Recargar" buttons and the error retries) skips the kept list but still
  joins a running search; pushed refreshes do not send it. A failure or a
  `disabled` answer is never kept, and a failed search drops the kept list, so
  the read after an error push shows the error. Saving a Jira connection
  (the OAuth callback) drops the kept list and any search started before it.
- **Deadlines.** `Bun.serve` resets a request whose handler has sent nothing
  for `idleTimeout` seconds; it is 120 s, above the longest route (a ticket
  launch in an env: a Jira read plus a terminal create). Each provider call
  (every Jira page, token refresh and retry, the GitHub fetch) shares one
  25 s deadline per operation, under Playwright's 30 s request timeout. Calls
  to the PTY host are bounded at 5 s, and at 45 s for creating a terminal or
  an env. A timeout is a `ProviderError` with status 504, answered as 502
  with `status: 504` in the JSON. `GET /api/events` has no timeout.
- **Lazy terminal window.** The `/terminal/:id` route loads `terminal-page.tsx`,
  and with it `window.tsx` (and xterm with its CSS), as a separate chunk on first use;
  the dashboard never
  downloads xterm.
- **Environments.** Worktree environments come from a generic env provider
  configured in `data/config.json` (`envs.bin`, `envs.root`, `envs.repos`); no
  product names live in the code. An env is launchable only if the provider's
  `list --json` names it, its directory sits directly under the realpath of
  `envs.root` and is a real directory, and each launch target is a real
  directory holding a `.git` directory or file (none of them a symlink).
  Loose git worktrees of a profile repo are `wt:<repo>:<branch>` (ADR 0005).
  `env:<name>` targets the env directory itself, which holds the repos rather
  than a `.git`. Directories the provider does not list are never offered. This is
  checked on **every** launch, so a stale page or a failed create cannot start
  an agent in the wrong place. A provider failure is a 502 naming the provider,
  never an empty list. The checks are not atomic with the spawn: swapping a
  directory for a symlink in between needs a local process of the same user,
  which is outside the threat model (see Consequences).
- **Creating an env.** The provider's `create` runs in a visible terminal of kind
  `env`, without `--json` (progress stays visible). Since 2026-10-07 it passes
  `--yes` (ADR 0012): the provider never asks which other envs to stop, and stops
  none. The browser sends a name, repos from the configured allowlist and a ticket
  key; the branch is `feature/<key>`, created from the default branch when missing.
  Each value is validated on its own so none can be an option. The server never chains a launch onto the create: the create window
  offers the launch once it exits with code 0, and that launch goes through the
  check above. A second create of the same env is rejected while the first is
  still running. A create stopped midway can leave a partial env; the app says so
  and never cleans it up. Since 2026-10-05 the "Nuevo entorno" modal runs the
  create as a server job with `--yes` and shows its output as text (ADR 0005);
  the terminal create stays for the Mesa's rail.
- **Agent on a ticket.** The server fetches the ticket and its comments from
  Jira and builds the prompt: a fixed header naming only the validated issue key
  and its link on the configured site, every other ticket field (summary,
  assignee, priority, labels, description and each comment's author, date and
  text) inside `<ticket>` marked as untrusted data (control characters stripped,
  `</ticket` neutralised), and a fixed tail asking for a plan and forbidding
  commit, push and Jira writes. A PR review is built the same way: its link in
  the header, and its description, conversation, reviews and line comments
  inside `<pr>`. The prompt fits the 16 KB limit with the tail intact: the
  description takes at most 6 KB, cut in bytes on a UTF-8 boundary; the comments
  fill the rest newest first, are shown oldest first, and a line counts the
  older ones left out and points to the link. A failed comment read fails the
  launch or the bring; it is never sent as a ticket without comments. At the local user's
  request (2026-10-06), every new or resumed agent terminal uses permission bypass,
  with or without a prompt: Claude `--dangerously-skip-permissions`, Codex
  `--dangerously-bypass-approvals-and-sandbox`, and Grok `--always-approve --no-plan`.
  This replaces the enforced plan/read-only launch mode. Ticket and PR prompts
  still request a plan, but permissions no longer enforce that request. Native
  managed restrictions, hooks and Grok deny rules may still block actions.

## Consequences

- The working directory is a start directory, not a security boundary. Agent
  terminals use permission bypass and can edit files and run commands without
  ordinary confirmation prompts; the UI says so. Codex also disables its sandbox.
- Terminals survive a server restart (`bun --watch`, Ctrl+C, a crash), not a
  host restart; agents with a known session id come back with permission bypass (ADR
  0008), shells and envs do not. Changing host code needs the running terminals stopped, and
  any change to a host route or frame needs `PROTOCOL` bumped by hand.
- Anything that can read `pty-host.json` (a local process of the same user)
  can drive every terminal; the same trust model as the rest of the app.
- Jobs that leave the process group (`setsid`, `disown` into a new group) can
  survive Stop.
- The guard protects against hostile web pages, not against local processes
  of the same user.

## Verification

`server/features/terminals/terminals.test.ts` covers the environment strip, the
splitter (BEL and CAN inside a CSI), snapshot + live equivalence, the scroll
region and hidden cursor, the overflow reset during a write, the argv map and
prompt rules, location resolution through symlinks, tokens (replay, wrong
terminal, wrong origin, expiry), the upgrade guard on a real server, an
unauthenticated socket that gets nothing and displaces nobody, takeover, busy
without `take`, a closed holder not counted as busy, exit
codes, Stop with background descendants (also ones that ignore SIGHUP), the
exit notice after the last output, a stale queued attach, the snapshot
allowance, concurrent launches against the cap, and the slow-client drop.
A mutation pass confirmed each regression test fails without its fix, except
the exit-order test: that race did not reproduce, so it is a guard only.
`server/features/terminals/name.test.ts` covers the name's rules (40
characters, control and bidi characters refused), a rename announced once and
kept by an ended terminal, both routes behind the guard, and "Abrir carpeta"
running a recording editor with exactly the terminal's cwd while ignoring a
path in the body, and a cwd that is gone (409, the editor never runs);
`server/host/host.test.ts` the host route and its token. `e2e/rename.e2e.ts`
renames from the header (Enter saves, Esc sends nothing), finds the name whole
on a Mesa tile, in its picker and in the palette, checks the fake editor's argv,
and shows a failed "Abrir carpeta" in words. Mutations caught: the label
ignoring the name, the schema accepting `\p{Cf}`, the route without its
existence check, the error text without its map, and the narrow tile keeping
the state word (the name cut to "Pru…"). The screen's `overflow-hidden` and the
cwd's `flex-1` each have a test that failed before the fix (the page scrolled
874 px at 390 px; the name was cut on a 512 px header).

`server/host/host.test.ts` covers the host file mode, the lock (live, stale,
garbage), config edits and a broken edit, the idle exit, `lost` marked only by
the host, the token and Origin checks on HTTP and WebSocket, snapshot and live
output through the proxy, a second server reattaching to the same screen,
takeover and busy through the proxy, a window that closes while the host comes
up holding nothing, overflow and 404 codes, the slow-window drop, a vanished host (4503 and a typed
error), the busy shutdown, and one real host started detached, reused and
cleaned up on SIGTERM. With claude, codex and grok live in three windows, the
built server was stopped with SIGINT and started again: each window showed
"reconectando…", came back with the same screen and took keys, the host kept
its pid, and the rows ended `exited`, not `lost`. Without a server the host
exited by itself after 30 s. The hop to the host adds about 0.1 ms to a
keystroke's echo (median 1.17 ms in process, 1.25–1.28 ms through the host).

`server/features/envs/envs.test.ts` drives a fake provider CLI over a fixture
tree (leftover dirs, a `.git` file, a dir without `.git`, a symlinked `.git`,
an env that is a symlink, symlinks out of the env and out of the root): listing, every rejected location, the re-check at
launch after the env leaves the list, the exact create argv, option-like names
and branches, the create terminal, a double create of the same env, provider
output of the wrong shape and a missing binary, the routes, and the ticket
prompt (quote escape, NUL, hostile key and summary, byte truncation of
multibyte text). `web/features/terminals/launch.test.tsx` covers the default
location and the fallback when a refetch drops the picked env. Before the 2026-10-06 permission change, each harness was launched on a real
ticket in a real env with the first prompt layout: the prompt arrived, the plan
mode showed, and `git status --porcelain` and `HEAD` were unchanged after Stop.
With the current layout, `claude` was launched again the same way: its argv had
the key alone in the header and `Summary:` inside `<ticket>`, plan mode was on,
its session file existed but `/api/sessions` did not list it, and the env's
repos were unchanged after Stop.

`server/features/jira/ticket-cache.test.ts` counts the calls to a fake Jira
with a fake clock: a second read within 60 s makes none and one after it makes
one; fresh and concurrent reads share one search; a failure and `disabled` are
not kept and a failed fresh read drops the kept list; a stale search started
before `invalidate()` neither commits nor is joined; the watcher's baseline
comes from the cache and a later fresh check publishes; the route passes
`?fresh=1`. `web/features/tickets/tickets.test.tsx` checks that a refresh asks
fresh once and later pushed reads do not. `server/deadline.test.ts` covers a Node
client against a slow handler (reset at Bun's default, answered with the app's
idle timeout) and a caller leaving a shared wait at its deadline;
`server/features/jira/deadline.test.ts` covers two Jira pages that together
pass the deadline, a Jira that never answers and a stalled body, each a 504.
The idle events e2e holds the stream for 25 s, past Bun's default. `e2e/terminal.e2e.ts` checks that the dashboard loads no
script containing xterm, and opens a shell window: it fits, echoes keys and
shows the same screen after a reload. `e2e/events.e2e.ts` runs as its own
Playwright project after the rest, because it counts requests and other
workers' pushes would reach it. A mutation pass confirmed the cache, baseline
and lazy-route tests fail without their fix. On the built server the entry
chunk went from 724 KB to 388 KB.

## External sessions

The right column also lists harness sessions running outside the app, view
only: nothing reads keys, writes, signals or attaches.

- **Sources.** Claude Code `~/.claude/sessions/<pid>.json` (only `<pid>.json`;
  the `*.key` files beside them are never opened, and the messaging socket path
  is never returned), Grok `~/.grok/active_sessions.json`, and Codex rollouts
  under `~/.codex/sessions/YYYY/MM/DD` from the last 24 h (header line only).
- **Honest states.** `activa` needs proof of the process: for Claude the pid is
  alive and its start time matches `procStart`; for Grok the pid runs a `grok`
  binary that started no later than 10 s after `opened_at`. Codex keeps no pid,
  so its sessions are only `reciente` (rollout written in the last 10 min) or
  `desconocida`. A proven
  dead or reused pid counts as ended; an unreadable file is skipped and counted.
- **Process lookup.** One `ps` call per harness, with a fixed env (`TZ=UTC`,
  `LC_ALL=C`). Pids above the platform's PID_MAX are dropped first, because
  macOS `ps` fails the whole call on one of them.
- **Limits.** Only the app's direct terminal processes are filtered out: a
  harness started from an app shell terminal, or any Codex launched by the app,
  shows up as external. Codex rollouts are looked up in the last 7 day
  directories and kept when written in the last 24 h, so a Codex session
  started more than 7 days ago is not shown even while it still writes.

`server/features/sessions/sessions.test.ts` covers the three scanners on a
fixture home (reused and dead pids, an app pid, bad and wrong-shape files, a
key file that must stay unread, Codex windows by mtime), the real `ps` with an
out-of-range pid, and the route behind the local guard.
