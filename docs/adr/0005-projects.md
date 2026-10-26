# ADR 0005 — Projects and worktrees

Status: accepted (2026-10-02). Covers B5.1, the read-only tree; the agent view,
the env command runner and native worktrees extend it.

## Context

Agents run in places, and the places are of two kinds. An **env** from the env
provider (ADR 0003) is one ticket: a directory under `envs.root` holding one
worktree per repo of the product, all on the ticket's branch. A **repo** from the
profile's `repos` is a plain checkout with its own git worktrees. The home column
listed terminals flat, so the user could not see which agent worked where, and
the env's worktrees showed up a second time in each repo's `git worktree list`.

## Decision

- **One tree, three kinds of section.** The third home column ("Proyectos") lists
  Entornos (the provider's `list --json`), one section per repo `group` in
  `config.repos` (the main checkout plus loose worktrees; the group's name lives
  only in `data/config.json`), and «Otros proyectos»: the repos in no group, the
  `app` location and the terminals of no node. A repo is a heading
  (`repo-group:<id>`: git icon, name, «⋯» with Nuevo worktree and Quitar repo, the
  running count while folded) that launches nothing; under it sit its checkouts as
  sibling rows: main (`repo:<id>`, named by its branch, tagged «principal», labelled
  `<id>/<branch>`) and each worktree (tagged «worktree»). When `config.repos` lists
  the app's own folder, Agentic OS is that repo (2026-10-07): `GET /api/projects`
  answers `app.location: "repo:<id>"`, the folder node goes, and the `app`
  location (kept for old links and launches) and the terminals of no node sit
  under that repo's main row. `addRepo` accepts the app's folder itself, never one
  inside or around it. "Añadir repo" there opens the
  app's folder picker and appends the chosen git root to
  `config.repos` as a local-only repo, written atomically and validated as a whole;
  the server adopts it in memory and the PTY host re-reads the file on its next
  launch, so neither restarts. Only such a repo (no group, no GitHub) leaves the
  list from the tree, and never while a terminal runs inside it. Each node
  has a "+" that opens a terminal there, and the terminals running in a node
  are listed under it. The terminal list and the sessions panel are not
  separate any more: terminals live in the tree, sessions in the Memoria column.
- **Choosing a folder in the app, not in a macOS dialog.** The server never opens
  windows on the host: a dialog from a background process takes 2-3 s to show
  (AppleScript `activate`), the AppKit call that speeds it up is marked for
  deprecation and its replacement does not promise to bring the window forward,
  and no remote device or e2e can drive it. Instead `server/features/files/`
  lists one folder at a time (`GET /api/files/folders?path=`: realpath, folders
  only, hidden ones left out, a `.git` mark per folder, at most 2000) and the
  places to start from (`GET /api/files/places`: the folder holding the repos,
  home, the envs and worktrees roots). A missing folder is 404, a file 400, and a
  folder macOS privacy keeps from the server 403, each with its words. It knows
  nothing of repos: the web's `FolderPicker` takes what can be picked and the
  row tags from its caller, so a later picker (notes folder, a shell anywhere)
  reuses it. Listing folders and adding a repo were first local-desktop only;
  they now work remotely too (`server/remote-routes.ts` declares each route's reach).
- **Who owns a worktree.** `git worktree list --porcelain -z` (fixed argv,
  `git.bin` from config, cwd the repo's real path, 10 s timeout) runs on every
  repo. Paths are compared after `realpath` on both sides. A worktree under
  `envs.root` belongs to its env: it is shown only there, labelled with the
  repo and branch git reports, never guessed from the directory name. A
  worktree inside another repo's checkout (a submodule's) is hidden; the
  checkout is the place to work. A record whose path no longer exists is
  dropped. A repo whose scan fails keeps its own error; the others still show.
- **`wt:<repo>:<branch>` locations.** A loose worktree on a branch gets the
  location `wt:<repo>:<branch>`. The PTY host resolves it on every launch
  against a fresh worktree list: the repo must be in the profile and the
  branch checked out in one of its loose worktrees. The branch from the client
  is only compared, never passed to git or joined into a path. Detached
  worktrees get no location and cannot be launched in. `PROTOCOL` was bumped
  with this change, so a host from before is replaced once it runs nothing.
- **`GET /api/projects`.** Returns the envs (with their checkouts, locations
  and proxy hosts), the repos and the app location. The provider's list takes
  about two seconds, so it is cached on the server with the proxy status, one
  load at a time, and an invalidated load never fills the cache. The cache is
  dropped when an env-kind terminal ends and on `?fresh=1` ("Actualizar" and
  the error retries). The git scan is not cached: it runs on each request and
  takes milliseconds. A provider failure, or an `envs.root` that does not
  exist, stays on the envs group (`error`); a provider that is not configured
  is `configured: false`. While the tree loads (seconds on a cold server) or
  when the route fails, the column lists every terminal flat, so Parar and
  Quitar are never out of reach.
- **Change events.** `projects` is a fourth SSE topic. The server publishes it
  when a terminal ends, since an env command may have changed the env list and
  a shell may have added a worktree. Nothing polls, so an idle dashboard still
  makes no requests. Worktrees created outside the app show on the next read:
  a terminal ending, "Actualizar", or a page load.
- **Links.** An env links to its `url` and to the proxy hosts whose first label
  is the env name or ends in `-<name>`. Only `http(s)` URLs that parse reach an
  `href`; a proxy host must look like a host name (with an optional port) and
  is opened over `https`. The app never computes ports.

## Acting on the tree (2026-10-03)

- **Git.** Status and diff run with `GIT_OPTIONAL_LOCKS=0` and
  `GIT_TERMINAL_PROMPT=0`, so a read never takes the user's index lock or waits
  on a prompt; a diff is only for a path the status lists. Status lists
  every untracked file (`--untracked-files=all`), an untracked file is diffed
  against `/dev/null` with `--no-index` (exit 1 means a difference), and a diff
  stops at 512 KB and says so. A location that is not a checkout (`app`, an
  env root) answers `{repo: false}`, shown as "no es un repo", not as an error.
  Reads resolve env locations against the cached env list, with the same
  realpath containment, because a click per file cannot wait two seconds for
  the provider; launches and refusals keep the fresh list. Keeping a checkout
  up to date is `fetch --prune` plus `merge --ff-only @{upstream}` (with
  `submodule.recurse=false`), then `submodule update --init --recursive`, as
  the repos' READMEs do; never `pull`. It is refused with a reason (409) when
  busy, with a terminal inside, detached, without an upstream, when diverged,
  or on an env checkout (the env's own update owns those). Local changes do not
  block it: git refuses when the update would overwrite one, and that refusal
  names the files. Until 2026-10-05 any changed tracked file blocked it, and a
  submodule on another commit counted as one, so the backend and frontend
  checkouts never moved. A submodule with its own changes or commits no remote
  has is left where it is and the answer says so. "Actualizar repos" runs it
  on every repo and answers one line per repo; `git.autoUpdateMinutes` repeats
  it on the server (default off).
  Stage, commit and push came on 2026-10-06 as a Mesa tile per checkout: ADR 0009.
- **Native worktrees.** `POST/DELETE /api/projects/worktrees` add and remove
  them under `realpath(worktrees.root)/<repo>/<slug>`; without the root the
  action is hidden with its reason. The branch passes `check-ref-format`, the
  slug is one segment, and the target must not exist. The server fetches first
  (a failed fetch still adds, from what the clone has, and says so); the default
  base is `origin/HEAD`, then `ls-remote --symref`, and `remote set-head` is
  never run. Remove never uses `--force`: it is refused with a terminal inside,
  with initialized submodules, and with ignored files unless the user confirms
  ("Quitar igualmente"), because git deletes those silently. The branch stays.
  The base is picked from `GET /api/projects/repos/:id/branches` (local and
  remote branches). Env repos are allowed too, for a quick fix without the
  env's containers.
- **Env commands.** `POST /api/envs/run {action, name?, confirm?}` maps each
  action to a fixed argv, and runs it in a visible env-kind
  terminal in the PTY host. The host refuses a command that conflicts with a
  running one: the same env, or a tool command against itself; reads never
  conflict. `remove` needs the env's name typed in the app, then the provider
  asks again in the terminal. A `remove` terminal is refused while any terminal
  runs inside the env, and a name the provider does not list is refused. A remove
  job first stops the env's own logs terminals (they only read it, and a
  forgotten one blocked every remove) and the terminals inside the env that the
  modal listed (`close`: their ids, from the preview's `open`). Since 2026-10-07
  an open terminal no longer means closing the modal to hunt it down: the last
  step names each one ("Se cierran N terminales abiertas") and the existing tick
  covers it. A remove the conflict rules refuse closes nothing. Any other
  terminal still running inside the env, one opened after the modal read the
  list, refuses the remove, naming it and its folder. A remove that ends well
  also takes the env's ended terminals off the list; a failed one keeps them. An env
  terminal is named by its command ("Logs", "Diagnóstico"), not by its kind,
  so two commands on one env tell apart. A new env appears in the tree once
  the provider lists it; until then its create terminal is the tile. Since
  2026-10-05 only the logs and the Mesa rail's start and create still use this
  route; the rest run as jobs (below).
- **Env state and one click (2026-10-05).** Each env shows a badge from the
  provider's own `servers` per repo (`"stopped"` or the servers alive):
  levantado, a medias, parado, or trabajando… while a create, start, stop,
  update or remove terminal of it runs (`envState`). The row offers Levantar
  (when not up) or Parar (up or a medias) and Logs, each one click into a tile.
  A ticket in the Mesa's rail shows its env (by branch or by name) with the same
  badge and Levantar, or "Crear entorno" with the ticket as branch and name and
  every repo. The new-env form says under its button why it is disabled, takes
  the name in lowercase and refuses a name already taken; the name rule is one
  shared pattern (`shared/envs.ts`) for the form and the server.

## Env commands without a terminal (2026-10-05)

- **What the app offers.** The Entornos block's header offers Nuevo entorno and
  Diagnóstico, each in a modal: the form with the create's progress, and Estado
  general (shared services, proxy and each env's badge) with Revisar (`doctor`).
  Until 2026-10-05 these lived in an envs node, "Gestionar entornos", opened in
  the drawer; the user asked for the buttons directly. An env command whose env
  is not listed now shows among the loose terminals. Each env offers Arrancar, Parar, Actualizar, Logs and Borrar.
  Since 2026-10-06 they sit on the env's row in the tree (Levantar or Parar in
  sight, the rest behind "⋯"), not in the drawer, and a command's output opens
  as a job tile in the Mesa (ADR 0006). The
  per-env proxy, the submodule contract commands, `shared stop`/`shared down`,
  `proxy stop`, `fix-hooks` and the status commands as terminals are gone from
  the app and the server: the user did not use them, and the destructive ones
  are one terminal away.
- **Jobs in the server.** `POST /api/envs/jobs` (zod: create, start, stop,
  update, remove, doctor) runs the provider's fixed argv with `Bun.spawn` in the
  server, at the provider's root, stdin closed and stdout and stderr piped.
  Without a TTY the provider never prompts and prints its progress as plain
  lines; escape sequences are stripped and a carriage return ends a line. The
  last 256 KB are kept. `GET /api/envs/jobs` lists them, newest first, and
  `GET /api/envs/jobs/:id` returns one with its output; the panel reads it every
  second while it runs. A job that runs 30 min is killed. The PTY host and its
  protocol are unchanged, so no host restart. A job starting or ending
  publishes the `envjobs` topic; an end also drops the env cache and publishes
  `projects`. Logs never end, so they still open a terminal.
- **One command per env, across both.** A job checks the running env terminals
  and the running jobs with the same conflict rules; the terminal routes check
  the running jobs too. The env must be listed by the provider, except for a
  create. The badge reads "trabajando…" while a job of the env runs.
- **Remove after a dry run, in up to three steps.** "Borrar entorno…" opens a
  modal and reads `GET /api/envs/:name/remove-preview` (`remove <env> --dry-run
  --json`, 60 s): uncommitted changes and commits in no remote, per repo, and a
  `fingerprint` (sha256 of those losses, keys sorted), plus `open`, the terminals
  running inside the env (not in the fingerprint). Step 1 says what goes;
  step 2, only with losses, lists every one of them and needs "He revisado" ticked;
  step 3, "Último aviso", needs one more box ticked ("Sí, borrar <env>"); the
  client sends the name as `confirm`, which the server still requires. Leftovers (a PR review
  report, a helper doc) are the common case, so losses do not block the remove:
  the job sends the fingerprint as `seen`, and the server runs the dry run again
  right before spawning. Losses with no `seen`, or a different fingerprint, are
  refused ("vuelve a revisarlo"), so only what the user saw is lost; matching
  losses run `remove <env> --yes --force-dirty`. A clean env runs `--yes` alone,
  whatever the client sends; the decision comes from the server's own read. The
  create job adds `--yes` too, and so does `start` in a job or a terminal: the
  provider then never offers to stop other envs and stops none (ADR 0012). No other
  command carries it.
- **Status.** `GET /api/envs/status` runs `shared status --json` and
  `proxy status --json`, each zod-checked, each with its own error beside the
  other's value.

## Consequences

- The tree is as fresh as its last read. A worktree added or removed in a
  shell outside the app is missing until one of the triggers above.
- The badge is as fresh as the env list: it changes when an env terminal ends
  or on "Actualizar". A server that dies on its own shows as up until then.
- Jobs live in the server's memory: a server restart kills the running ones and
  forgets the finished ones (the last 20 are kept). The provider's own state is
  what counts; the next list shows it.
- The conflict check between a terminal and a job is not atomic across the
  server and the PTY host: two clicks within milliseconds, one from the rail
  and one from the panel, could both start. The provider locks its own
  registry file, which does not keep two commands off one env.
- Proxy hosts are assumed to serve `https`. A provider that serves plain `http`
  on its hosts would give broken links until it says so in its JSON.
- An env-owned worktree cannot be launched by `wt:`; it is launched through its
  env location (`env:<name>/<dir>`), which keeps the env checks of ADR 0003.

## Verification

`server/features/projects/projects.test.ts` runs on temp repos with real git:
porcelain parsing (a path with a newline, bare, detached, locked and prunable),
classification (main, loose, env-owned, submodule inside another checkout,
nested in its own repo, a repo reached through a symlink, a removed worktree), a
missing repo and one git refuses beside working ones,
`wt:` resolution (unknown repo, unknown branch, a branch only in an env, a
detached worktree, a removed worktree, malformed ids), the env cache (one load at a time,
invalidation during a load, a failed load not kept), `watchEnded` (publishes
once per ended terminal, drops the cache only for env-kind ones) and the route, a missing env root included.
`web/features/projects/tree.test.tsx` covers grouping by location, the links
filter (`javascript:` URLs and bad hosts rejected), the tree's names and labels,
the loading, error, disabled and empty states, and the flat list of terminals
while the tree loads or fails. `e2e/projects.e2e.ts`
compares the tree with `/api/projects` on the running server, checks that no
control is clipped, and opens and removes a shell from the app node. On the real
profile the tree matched `list --json` and `git worktree list` for three envs and
three repos; the env list loads in about 4.5 s cold, 0.03 s cached.

`server/features/envs/jobs.test.ts` drives a fake provider CLI: the job's argv
(`--yes` only on create, start and remove), plain-text output from stdout and stderr,
a failed exit, the 256 KB tail, one command per env across jobs and terminals,
remove refused with anything running inside the env, the kept finished jobs,
`plainText`, and the routes (400 refusals in words, 201, 404, the status with one
part failing, the preview with empty repos dropped and a refused dry run as 502).
`web/features/projects/env.test.tsx` covers the job output (done, failed,
truncated, waiting), the remove choice with work pending and clean, and both
panes.
