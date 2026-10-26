# ADR 0007 — The workspace: projects page, agent monitor and palette

Status: accepted (2026-10-05). Extends ADR 0003 (terminals), ADR 0005 (projects)
and ADR 0006 (the Mesa). The projects page below is superseded the same day by
ADR 0006 "One place to work": `/proyectos` now redirects into the Mesa.

## Context

Block W turned the dashboard into the place where the user works instead of
Orca: a projects page with the terminal, git and env views of a node, a grid of
terminals, an agent monitor and a keyboard search. Most of its decisions extend
an earlier record and live there:

| Decision | Recorded in |
|---|---|
| Handover (`take`, `busy`, "Traer aquí"), host build fingerprint, activity | ADR 0003 |
| Git reads and fast-forward refusals, native worktrees, env commands | ADR 0005 |
| The Mesa (`/terminales`): tiles (terminals, git, env output), 6-tile cap, rail, bring, Jira login origin | ADR 0006 |

This record holds what had no home: the projects page, the agent monitor, the
palette and the visual direction.

## Decision

- **Projects page (`/proyectos`), superseded.** The tree on the left, the selected node on
  the right. What is shown rides in the search string (`node`, `t`, `tab`),
  because location ids hold `:` and `/` and a reload must reopen the same view.
  A node offers the views its kind allows: every node its terminals (a switcher,
  "Ventana aparte"), a checkout its git state, an env its commands, and the envs
  node only the commands on every env. Without a picked terminal the page shows
  the node's first running one. xterm loads with the first terminal shown, never
  with the tree. Below `md` the tree and the pane are one view at a time.
- **Agent monitor (`/agentes`).** State and activity come from the terminals
  list, which events keep fresh (ADR 0003). `GET /api/agents` adds what events
  cannot: CPU and memory per process tree from one `ps -A` call, the last
  non-blank line of a shell or env terminal (an agent's last rows are its own
  chrome, so they are never read), and the status word of a Claude the app
  started, from its session file. The same session scan feeds the sessions
  outside the app, which the monitor lists read-only beside its own. The page
  polls that route every 5 s and only while it is visible; a hidden tab reads
  nothing. Filters by harness and project ride in the search string (`h`, `p`).
  Rows sort by state and never move on a poll.
- **Palette (⌘K).** One search over pages, terminals, project nodes, tickets
  and PRs: accents and case ignored, every typed word must match, at most 8 per
  group. ⌘K opens it anywhere; Ctrl+K too, except inside a terminal, where it
  stays the shell's kill-line. A ticket or a PR goes into a Mesa tile in a
  second step through the Mesa's own bring (ADR 0006), so the same refusals hold
  and nothing is typed with Enter; off the Mesa it opens the item's page. Its
  lists load only while it is open, so a closed palette costs no request. It
  launches nothing: launching stays in the tree's "+".
- **Visual direction.** One colour per harness (`--h-*`), used as a dot or chip
  wherever a terminal is named, with at least 3:1 contrast on both panels and the
  terminal header. Text on the accent uses `--on-accent`, chosen per theme for
  at least 4.5:1. The values and components live in `docs/DESIGN_SYSTEM.md`; a
  new visual element needs a row there first.

## Consequences

- Every new view pays nothing while idle: the monitor polls only while
  visible, the palette reads only while open, the projects page reads on
  events. The 0-requests-while-idle rule of ADR 0003 still holds.
- The monitor's CPU and memory are at most 5 s old, and only exist while the
  page is open.
- A harness started from an app shell is still an outside session for the
  monitor (ADR 0003, External sessions).
- On Windows and Linux a focused terminal has no key to the palette (Ctrl+K is
  the shell's, Meta is the system key); only the button reaches it there.

## Verification

The workspace page and its test went with ADR 0006; the Mesa's tests
(`web/features/terminals/grid.test.tsx`, `web/features/projects/tree.test.tsx`) cover the
tree and tiles today.
`server/features/monitor/monitor.test.ts` parses `ps` rows (a root `ps` did not
list, the pid 0 self-parent), runs the real `ps`, merges app terminals with
outside sessions, never reads an agent's screen, and checks the route behind
the local guard. `web/features/monitor/page.test.tsx` checks the state words, the
sort, the filters, the counts and that the poll pauses while the tab is hidden
(`refetchIntervalInBackground` off; a mutation turning it on was caught by the
e2e). `web/features/palette/items.test.ts` covers the groups' order, the accent
fold, the every-word match and the per-group cap. `e2e/agents.e2e.ts`: a
shell printing for 8 s goes trabajando → en espera, a hidden page makes no read
for 12.5 s, and the row actions. `e2e/palette.e2e.ts`: a project by keyboard,
Ctrl+K inside a terminal, a ticket into a tile, no PR request while closed, and
a ticket off the Mesa opening its page.
