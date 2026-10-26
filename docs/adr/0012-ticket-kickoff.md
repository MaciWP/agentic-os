# ADR 0012 — Ticket kickoff

Status: implemented and unit/e2e tested; the live run on a real ticket is pending the PTY
host restart (2026-10-07).

## Decision

One click on a ticket gets the work under way, so that the user's next step is to answer
Claude's questions or approve its plan.

- **«Empezar»** (the user's own ticket or one nobody has, panel section «Arranque»): an env named after the
  key in lowercase, on `feature/<KEY>` from the default branch, with every repo the env
  provider offers. The services are started, then Claude opens in the env in native plan
  mode, with bypass available once the plan is approved
  (`--allow-dangerously-skip-permissions --permission-mode plan`). Its recipe makes it work
  with `/dev-workflow`, ask its questions before it presents the plan, implement until done,
  run the repo's checks and, at the end, measure the coverage of the lines it changed
  (adding the tests missing for changed logic), then stop. It does not commit or push. After Claude starts, the
  ticket is moved out of the default board's first column into its second when it sits in
  the first, and it is assigned to the user when nobody has it.
- **«Revisar a fondo»** (a teammate's ticket with open PRs by others, in «Revisión»): an
  env `rev-<key>` holding every repo the provider offers, as «Empezar» does: the PRs' repos
  on their PR's own branch (`repo@branch`), the rest on `feature/<KEY>`, which `--new` makes
  from the default branch where it is missing (a local branch that outlives the env). Since
  2026-10-08: an env with only the PRs' repos came out front-only or back-only, and the proxy
  serves an env, and so gives it its main and tenant URLs, only with both. MCP stays out of
  the provider's list; it is added by hand for an MCP ticket. The prompt
  says, per repo, the commit its checkout is at and the PR's own commit (`head.sha` from
  GitHub, not a branch of the same name, which a fork's PR would not be). The app never moves
  a checkout: Claude brings one that is behind to the PR's commit with `git merge --ff-only`,
  and leaves local changes or a diverged branch alone and says so. Claude opens with the
  usual bypass. Its
  recipe names the review skills (`/lessons-learned`,
  `/pr-review`, `/code-review`, `/review-pr` when present, `/pr-comments` with
  `/natural-writing`). It runs the tests, measures the coverage of the changed lines, and leaves the comments as a
  **pending** GitHub review that the user submits: the coverage goes in the review's summary,
  and each uncovered changed line with logic gets a comment. It does not edit, commit, push or write to Jira.
  Both recipes end by closing what Claude started (dev servers, background commands, browser
  tabs). «Revisar yo» stays a separate button.
- **A second review round** (the button clicked again while the review's Claude is open):
  the env is neither created nor started again, and no Claude is opened. The context file is
  read again, and the open Claude gets only what changed since the last round, pasted as one
  message: the new commit range per repo and the count of new PR comments. The last round's
  time is the context file's previous write. Nothing new sends nothing («Nada nuevo en las
  PRs»). A Claude mid-turn, or asking for a permission or a question, gets nothing, and the
  panel says so. With no Claude open, the review starts as the first time.
- **No questions on the way.** `envctl create` and `envctl start` run with `--yes`: other envs
  are never stopped and nothing is asked. There is no harness picker: Claude Code with its
  own default model and effort. «Lanzar agente» stays, folded, for a manual launch.

## Chain

`POST /api/kickoff {key, mode, prs?}` answers 202 at once; the server runs the chain and
publishes each step on the `kickoff` event topic. `GET /api/kickoff` lists the runs.

1. A Claude terminal already running on the ticket inside this env: a start reuses it and
   the chain ends there; a review goes on to the context and its second round (above).
2. A stale PTY host (it builds argv, so an old one has no plan mode): refused, with the
   restart hint, unless a review round only pastes to a Claude already open.
3. **Context.** The ticket's open PRs are read; a review keeps those by others, the ones
   the panel checked, one per repo, in repos the provider knows. A repo GitHub did not
   answer for stops a review; a start goes on and its context says the PRs were not read. The context file goes to
   `data/kickoff/<KEY>/<mode>.md`.
4. **Env.** When the provider does not list it, `create` runs as an env job (ADR 0005), so
   its output shows in the panel and in Entornos.
5. **Branch** (review only): each checkout's commit against its PR's commit, for the
   prompt. It never stops the chain.
6. **Services.** When the provider's list does not say "up", `start` runs as a job; a list
   that still says partial or down afterwards stops the chain.
7. **Agent.** Claude in `env:<name>` with the prompt below.
8. **Jira** (start only). A refusal becomes a warning: Claude is already working.

A step that fails stops the chain with its reason, and Claude never starts on top of it.
One chain per ticket runs at a time. The runs live in the server's memory only (the last 20
finished); a restart in the middle loses the run, not its terminals or env.

When the chain ends while the panel that started it is still open, the page goes to the
Mesa with Claude's terminal; otherwise the user keeps browsing, and the panel and the board
card show the state («arrancando…», «arranque falló»).

## Context file and prompt

The prompt is one argv element: a fixed header (the validated key and its link, the env's
name, directory, repos with their branches and app URL, the context file's path, and the
coverage report's path next to it, `<mode>-coverage.md`), then the user's recipe. The recipes are saved prompts in Notas → Prompts, «Empezar ticket.md» and
«Revisar ticket.md», written from the defaults in `server/features/kickoff/prompt.ts` when
missing and never overwritten.

The context file holds, as data and never instructions, everything inside one
`<context>` fence: every value passes `quoted`, and the whole body passes it again, so text
from Jira or GitHub can neither close the fence nor pass for one of its own headings:

| Block | Source |
|---|---|
| Ticket, acceptance criteria, description, comments | `getIssue`, `getComments` |
| Parent with its description | `getIssue` on the parent |
| Subtasks and linked tickets | `issue?fields=subtasks,issuelinks` |
| Remote links | `issue/{key}/remotelink` |
| Every URL found, grouped Confluence, Jira, Figma, GitHub, other | text of all the above |
| PRs with branch, description and discussion | `github.pull`, `github.discussion` |
| Earlier commits naming the key or its linked keys | `git log --all --grep` per repo |
| Notes, prompts and memories | up to 5: notes naming a key (exact phrase), then the Notas search for the summary; path, title and description, so the agent opens what it needs |

The Notas search lets any word match, but a hit must hold half the query's weight, each word
weighted by its rarity (BM25's idf; Elasticsearch calls it `minimum_should_match`). So a
ticket about nothing in the notes gets no notes, not five that share one common word. Index
files (`MEMORY.md`) and Grok's unreviewed `_inbox/` and `archive/` drafts are listed but not
searched.

The prompt header also tells the agent, as a fact, that it can search all the notes itself:
`bin/aos notes search "<words>"`, then `bin/aos notes read <id>`, with the absolute path
because `aos` is not on the PATH of Claude's Bash tool. A CLI costs no tool definitions in
the context, as an MCP server would. Whether agents use it shows in the server log:
`GET /api/memory/search` lines.

The ticket and its comments must read; any other block that fails says so in its place.
Confluence and Figma are linked, not fetched: the app's Jira OAuth has no Confluence
scopes, so Claude reads them with the Atlassian and Figma MCP servers.

## Rejected

- **A model and effort picker at the click**: the user wants Claude Code's defaults. The manual
  «Lanzar agente» form has an optional one (empty by default, each CLI's own), for a Lead on a
  cheaper model when the work is mechanical; the kickoff click stays without it.
- **The plan written into the ticket note**: Claude Code's own plan mode is the gate.
- **Review drafts in a local note**: a pending GitHub review is where they are used.
- **Plan mode for reviews**: it would block running the tests.
- **Chaining in the browser**: a closed tab would stop the chain halfway.

## Verification

`server/features/kickoff/*.test.ts` covers the context blocks, links, sanitising and
failing sources, and a forged fence or heading in a description staying inside the fence.
It covers the recipes (seeded once, the user's edit kept) and the prompt header. The
orchestrator tests check a new env created, started and launched in plan mode with the
ticket taken, an env already up reused with no job, and a Claude already running focused.
They check that a failed create, half-down services and a stale host stop the chain before
Claude, that a checkout behind its PR still launches with the catch-up line, that a second
review round pastes only the new commits or comments, sends nothing when nothing changed
and never pastes to a busy or asking Claude, that a Jira refusal is a warning, and that a
second click while running is refused. The route has a 400 for a bad key and a 409 when busy.
`web/features/tickets/flow.test.tsx` covers the button states, the PR checkboxes and the
card. `e2e/tickets-flow.e2e.ts` clicks both buttons with Jira, GitHub and the kickoff
answered by the browser.
