# ADR 0008 — Agent state, resume and usage

Status: accepted (2026-10-05). Extends ADR 0003 (terminals) and ADR 0007 (agent
monitor). The work item per ticket (ticket, env, terminals, PR, CI) is still to
come and will be added here.

## Context

The app guessed whether an agent was working by counting output bytes, lost its
agents for good when the PTY host restarted (the rows ended `lost` and nothing
read them), and did not know what any piece of work cost. The user wants three
things: the agent's real state, its terminal back after a host restart, and a
lasting record of tokens, cost and Poneglyph use (skills, commands, subagents,
tools, hooks) by session, ticket and env, to decide what to change in Poneglyph.

## Decision

- **State from the harness's own files.** Nothing is injected into a launch.
  The server (`server/features/agents/state.ts`) reads, for each running agent
  terminal: Claude's `~/.claude/sessions/<pid>.json` (the pid is the terminal's,
  since argv[0] is the binary; a record that started over 10 s before the
  terminal belongs to an earlier process with that pid); Grok's
  `~/.grok/active_sessions.json` by pid; and for Codex, the rollout under
  `~/.codex/sessions` that the terminal's process holds open (one `lsof` call for
  every running Codex). The session id is the end of the rollout's file name.
  Codex creates the file on the first message, appends to the old one on a
  resume and switches on `/resume` or `/new`, so the open file is always the
  current session (2026-10-07). It replaced a match by folder and start time,
  which gave several Codex terminals in one folder no session at all, missed
  resumed ones and took the Claude Codex plugin's rollouts. One `fs.watch` on
  Claude's sessions folder; Codex is read every 2 s while a Codex terminal
  runs. Only a change
  publishes the `terminals` topic. The PTY host and its protocol are unchanged:
  the server adds `agent: { sessionId, state }` to what the host returns.
- **Three states.** `working`: Claude `busy`, Codex `task_started`. `needs_you`:
  Claude `waiting` (a permission or a plan to approve) or `idle` (its turn
  ended), Codex `task_complete` or `turn_aborted`. `null`: unknown, so the UI
  falls back to the byte activity of ADR 0003. Codex records no approval
  request, so a Codex waiting on a permission reads as working. Grok has no
  state source and stays `null`.
- **Session id follows `/clear`.** The id read is written to
  `terminal_sessions.session_id` whenever it changes, so it is the one to
  resume, not the launch's.
- **What it works on (2026-10-07).** The tree's row says it: Claude's last
  `ai-title` and `last-prompt` records in its transcript
  (`~/.claude/projects/*/<session>.jsonl`), Codex's last `UserMessage` item in
  its rollout; Grok has none. Read backwards from the end, at most 4 MB, and
  again only when the file grew; clipped to 80 and 300 characters. Held in
  memory with the state and never stored; an ended agent keeps its last one.
  The same scan keeps what it last said (`lastMessage`: Claude's last
  assistant text, Codex's `task_complete` message; bold and code marks
  dropped, 300 characters) and, for Claude, the open question (`question`):
  an `AskUserQuestion` tool call with no tool result after it, shown only
  while the session file says it waits on input.
- **Resume after a host restart.** `terminal_sessions` keeps `name`, `model`,
  `effort` and a `resumes` count (migration 004). A host that shuts down leaves
  the rows of what it killed `running`; the next host marks them `lost` and
  `markLost` returns them. Each lost agent row with a session id and
  `resumes < 3` is relaunched with its own terminal id (Mesa tiles and windows
  attach again), ticket, name, model and effort, with `--resume <id>` (Codex:
  `codex resume <id>`) and the same permission bypass flags as a new terminal.
  A lost Codex without an id comes back on `codex resume` without one: Codex's
  list of that folder's sessions. The row is claimed by one `UPDATE …
  WHERE state = 'lost'`, so two hosts cannot resume it twice. Nothing is typed:
  the agent waits for the user and spends no tokens. The cap guards against a
  crash loop, not a long life: `markLost` sets `resumes` back to 0 for a row
  that ran 10 min or more before it was lost. A row at the cap stays `lost`;
  one whose folder is gone, or that finds the running cap full, stays `lost`
  with the reason in `error`.
- **«Reanudar» (2026-10-07).** The attach of a lost row that could come back
  answers 404 `lost` instead of `not_found`, and the window offers «Reanudar».
  `POST /api/terminals/:id/resume` asks the host (protocol 10) to relaunch that
  row the same way, past the cap, which starts counting again.
- **Usage read from transcripts.** `server/features/usage/ingest.ts` reads, at
  server start and every 5 min (and before a report when the last read is over
  a minute old), every Claude transcript (`~/.claude/projects/*/*.jsonl` and
  their `subagents/`), Codex rollout and Grok event log. Reading is incremental:
  `agent_sources` keeps the bytes read per file; a read stops at the last
  complete line and a file that shrank is read again from the start. Rows and
  the offset are written in one transaction, keyed by the harness's own ids, so
  a repeat read never counts a call twice. Every session is counted (app, Orca,
  a terminal of the user's own), not only the app's.
- **What is kept.** Counters and names only, never text: per call (Claude
  `message.id`, Codex response id, Grok turn and model) the model and input,
  cache read, cache write (1 h apart) and output tokens, plus the skill Claude
  attributes it to and the subagent type; per event (`agent_events`) the skill
  loaded, the command typed, the subagent and the model asked for, the tool or
  MCP server called, and each hook run with its outcome (ok, block, error,
  timeout) and duration. Codex counts cached tokens inside its input; they are
  taken out so every harness means the same. Grok's tokens come from
  `grok usage <id>` (argv, 15 s), run only when its log grew; "No usage
  recorded" is no usage, not an error. Migration 005 holds the four tables.
  Each read ends by pruning calls and events older than `USAGE_KEEP_MS` (400
  days, `server/retention.ts`) and the offsets of transcripts that no longer
  exist; an existing file keeps its offset, so it is never read back in.
- **Where the work happened.** A call's place is its folder and git branch
  (`agent_places`). The ticket is the configured Jira project's key in the
  branch, else in the folder, bounded (`ABC-10` is not `ABC-1033`), in any case.
  The location is the env under `envs.root`, else the worktree under
  `worktrees.root`, else the configured repo, else the git checkout the folder
  sits in, else the folder's name.
- **Cost is computed, never stored.** `pricing` in `data/config.json` maps a
  model prefix (the longest wins) to $/MTok for input, output, cache read,
  cache write and optionally the 1 h cache write. Changing a price re-prices
  all history. A model without a price shows "—" and is listed apart, never
  as zero. The page says "equivalente API": a subscription is not billed per
  token.
- **`/consumo`.** `GET /api/usage?from&to` (local days, both included, zod
  checked) answers by ticket, location, session (the 100 that cost most), model,
  skill, subagent, command, tool, MCP server and hook. The page reads it every
  minute while visible (ADR 0007) and shows a failed transcript read as an
  alert, not as missing numbers.

## Consequences

- The state depends on files the harnesses do not document. Each read is
  zod-checked; a format change gives `null` and the byte activity, never an
  invented state.
- A resumed agent is a new process: what it was doing mid-turn is lost, the
  conversation is not.
- Claude deletes transcripts after 30 days; what was read before stays in the
  database. A transcript deleted before its first read is never counted.
- Hook blocks are read from the tool error text (`PreToolUse:Bash hook error:`);
  one that does not name its hook counts under the event name.
- The first read of about 500 MB of transcripts took 8 s; later reads only touch
  what grew.

## Verification

`server/features/agents/state.test.ts` covers Claude's status words, an earlier
process with the same pid, Grok by pid, Codex's last turn event, lsof's
output and a real lsof of an open file, the session id written once and
listeners told only on change, an ended agent with no state, Codex terminals in
one folder each taking the rollout their process holds, and a `/resume` moving
the session. `server/host/host.test.ts` covers agents killed by a host
shutdown coming back once with the next host, a crash loop stopping at the cap,
a long-lived session counting again, a Codex without id on its picker, and one
whose folder is gone staying lost with the reason;
`server/features/terminals/terminals.test.ts` the resume and picker argv with
permission bypass and no prompt, the `lost` attach and «Reanudar». A spike on
2026-10-07 confirmed that the Codex TUI (0.160.1) holds its rollout open from
the first message. Historical live verification before the 2026-10-06 permission change: a Claude launched from the Mesa went working → needs you →
working; after a real host restart it came back with the same terminal id and
name, `resumes = 1`, in plan mode and in the same conversation.

`server/features/usage/usage.test.ts` covers the three readers (tokens and the
1 h cache, the attributed skill, synthetic messages skipped, tools, skills,
subagents, commands, hook outcomes and blocks, a long hook command read in
linear time, Codex records with the cache taken out and the older running
total), incremental reads (half-written line, rewrite, subagent files, Grok
without usage), the place rules, prices and the report and its route.
`web/features/usage/page.test.tsx` covers the page. Against the real data a
Claude session matched a hand count of its transcript deduplicated by
`message.id` (767 calls; input 1 564, cache read 96 990 221, cache write
3 218 492, output 539 405; 23 skill loads), and a Grok session matched
`grok usage` (3 550 841 / 3 304 320 / 59 100).
