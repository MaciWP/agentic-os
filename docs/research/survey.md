# Survey — agent cockpits worth copying (2026-09-30)

Scope: products that shipped cockpit-like features in 2026 and map onto these
pain points (P1 Jira
copy-paste, P2 retyped review instructions, P3 manual multi-model runs, P4 PR
comments one by one, P5 losing track of worktrees/PRs, P6 forgotten decisions).
Every source below was opened; unverified claims are listed at the end.

## Products

| Product | Best idea to copy | Pain | Source |
|---|---|---|---|
| Claude Code agent view | Sessions grouped by state; one-line summary per row; Space peek + reply | P5 | code.claude.com/docs/en/agent-view |
| Claude Code Desktop | Click diff lines, send all comments at once; auto-archive on merge | P4, P5 | code.claude.com/docs/en/desktop |
| Claude Projects | Overview grouped Ready / Waiting on you / Working; PR-card actions (Fix CI, Address comments) | P5, P4 | code.claude.com/docs/en/claude-projects |
| Claude auto-fix and routines | Review-thread replies labelled as agent-written; asks when ambiguous; saved "manual" prompts with history | P4, P2 | code.claude.com/docs/en/claude-code-on-the-web |
| GitHub Agent HQ | Assign one issue to several agents and compare the drafts | P3, P5 | github.blog changelog 2026-02-04 |
| Copilot for Jira (GA 2026-06) | The agent reads description, comments and custom fields itself | P1 | github.blog changelog 2026-06-25 |
| Copilot app (preview) | One "My Work" view; addressed comments resolved on re-review | P5, P4 | github.blog changelog 2026-09-18 |
| Rovo Dev in Jira | Coding run started from a work item with its acceptance criteria | P1, P2 | support.atlassian.com/rovo |
| OpenCode | Markdown commands with `$ARGUMENTS`, `@file`, `` !`cmd` `` and a model per command | P2, P6 | opencode.ai/docs/commands |
| Goose recipes | Typed parameters, prompt for missing values, pass/fail checks, JSON output schema | P2 | goose-docs.ai recipe reference |
| Devin Review | Diff grouped by logic; severity-ranked findings sidebar | P4 | docs.devin.ai devin-review |
| Warp, Superset, Nimbalyst, Zed, Amp, Jules, Factory | Command palette, per-workspace scripts, plan approval before code, @-mention past threads | P5, P6 | vendor changelogs |
| Reflect, Obsidian Copilot, Mem | Local Markdown, daily note, backlinks, agents inside the vault | P6 | reflect.app, obsidian plugins |

"Agentic OS" GitHub repositories have no real traction (top one ~2.4k stars, generic). Skipped.

## Top 12 patterns (ranked by time saved)

1. **Ticket-as-context loader** — enter a key, get a clean brief (description, ACs, fields, comments) the agent reads directly.
2. **State-grouped inbox** — Needs you / Ready for review / Working / Done across tickets, PRs and runs.
3. **One-line summary per row, peek and reply in place.**
4. **Batched inline review** — collect notes on diff lines, send once.
5. **PR-card actions** — Fix CI, Address comments, Resolve conflicts.
6. **Review-thread responder with a draft gate** — drafts in Conventional Comments, approved before posting.
7. **Prompt templates with typed variables** and injected context; model per template.
8. **Fan-out to several models** with a side-by-side comparison.
9. **Scoped review presets** — scope, other usages, simplest solution; never style.
10. **Lifecycle auto-cleanup** — on merge, archive the run, remove the worktree, suggest the transition.
11. **Grouped PR reading view** — logical order, moved code, severity sidebar.
12. **Searchable Markdown decision log** — daily note plus one note per ticket.

## Anti-patterns

1. **Trusting a green status.** "Exited without error" is not "the task worked"; read the outcome from the result.
2. **Silent schedules.** Skipped runs must be visible.
3. **An agent posting as the user with no gate.** Keep draft → approve.
4. **Expensive defaults.** Cheap model per template unless chosen otherwise.
5. **Cloud VMs or a third-party orchestrator as the core.** The dev setup lives on this machine; tools die (Crystal was deprecated).

## MoSCoW

| Priority | Features |
|---|---|
| Must | Today view by state; Jira read/assign/transition/comment; PR inbox + launch a review; Markdown notes; prompt library with variables; visible, cancellable agent runs; keyboard-first; ticket-as-context |
| Should | One-line run status; batched diff comments; PR-card actions; review-reply drafts; multi-model fan-out; auto-archive on merge; review presets |
| Could | Template checks and JSON schema; grouped diff view; saved routines; cross-session questions; semantic search |
| Won't | Cloud VMs; auto-merge; mobile; org governance; 100+ agents; canvases; a custom agent runtime |

## Not verified

Codex app dates and review queue; Codex best-of-N flags; Roo Code shutdown;
Factory's Jira integration; Copilot app Jira integration (changelog was image
alt text); OpenCode 1.18.13–1.18.29 notes; exact Amp dates.
