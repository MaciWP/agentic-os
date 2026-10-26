# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One user: a full-stack developer on a small team who runs the app locally on their own machine.
They work one ticket per git worktree, usually two or three at once, and drive several coding
agents in parallel (Claude Code as the main one, Codex and Grok for cross-checks). They speak
Spanish with people and agents and write code, commits and PRs in English. The app is open all
day beside the editor and the terminals; most visits are a glance to see what changed.

## Product Purpose

A local cockpit that answers "what needs me now?" across the user's tickets, pull requests,
notes, saved prompts and agent sessions, and turns each answer into the next action without
copy-paste: open the ticket's context, launch or bring an agent to it, review a PR, find a note.
Success means the user stops pasting whole Jira pages into agents, stops asking "¿qué queda
pendiente?", and notices a waiting agent within seconds.

## Positioning

It joins the user's own Jira tickets, GitHub PRs and live agent terminals in one place, on real
data from their accounts and their machine. A generic dashboard or a tracker's own UI cannot see
which local agent is waiting on which ticket's worktree.

## Operating Context

- Daily rituals: start a ticket (context → plan), implement with scope and reuse checks,
  cross-check with a second model, self-review before a PR, write the PR, answer review comments,
  review a teammate's PR, close the ticket with a short note for product.
- Tools around it: Jira (stories with points and acceptance criteria), GitHub (PRs, review
  threads with Conventional Comments labels), Claude Code, Codex and Grok CLIs, git worktrees.
- Runs as a single origin on `localhost`; several agent terminals live in the Mesa at once.

## Capabilities and Constraints

- Real data only: no mock data source ships; a failed provider fetch is shown as an error, never
  as an empty list.
- Tracker values stay as the tracker returns them (Jira status names and fields unchanged).
- No company data in the repository: project keys, field ids, repos and sites live in local
  config.
- Agent runs are read-only by default and follow a fixed tool list.
- Secrets live in the OS keychain only.
- Dark scheme only.
- Interface copy is Spanish (es-ES); code and docs are English.
- Keyboard: a command palette reaches any page, ticket, PR, note or prompt; no other global
  shortcuts (Notas has its own page keys: `/`, `j`/`k`, `e`).

## Brand Commitments

- Name: Agentic OS.
- Voice: short, clear, direct, plain words; tables or plain lists; no box-drawing separators.
- Each agent harness keeps its own colour (Claude, Codex, Grok, shell, env commands) as its
  identity cue.
- Text must never read like generic AI output:.

## Evidence on Hand

- Live data on the user's machine (Jira tickets, PRs, agent sessions). It is company data: it
  never enters the repository, and screenshots of it stay in the gitignored `data/` folder.
- No testimonials, metrics or external users exist; none may be invented.

## Product Principles

1. State before decoration: what changed, what waits, and on whom it waits, at a glance.
2. Every view ends in an action the user can take from there.
3. The provider's truth, shown as it is: real names, real errors, nothing invented.
4. Dense but calm: many items on screen, one clear focus.
5. Verifiable over impressive: every claim the app makes can be checked at its source.

## Accessibility & Inclusion

Keyboard reachable everywhere, visible focus, contrast at least 4.5:1 for text, state shown as
colour plus a word, and reduced motion respected.
