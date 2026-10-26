# Agentic OS

A local cockpit for a developer who works with several coding agents at once. It puts my
Jira tickets, GitHub pull requests, Markdown notes, saved prompts and live agent terminals
(Claude Code, Codex and Grok) in one window, and answers one question: what needs me now?

I built it for my own daily work and run it on my machine. It is a single-user app that
runs on `localhost`, and its interface is in Spanish.

## What it does

- **The Mesa.** A ticket, its git worktrees and the agent terminals working on it sit in one
  view. A terminal whose agent finished its turn or asked a question shows it within seconds.
- **Agent terminals.** Each agent runs as its own CLI in a real PTY. A separate PTY host keeps
  the terminals alive while the server restarts, and sessions resume afterwards.
- **Ticket kickoff and PR review.** One action loads a Jira ticket's description, acceptance
  criteria and comments into an agent, or starts a review of a PR with a fixed recipe.
- **Second opinions.** A read-only consultation sends the same question to another model, and
  agents can message each other and reserve files so two sessions never edit the same one.
- **Code and git.** A code view with Monaco and Shiki, stage, commit and push.
- **Voice dictation.** Hold ⌃⌘ in a terminal to dictate. Speech is decoded on the CPU by a
  local model (NVIDIA Parakeet through `sherpa-onnx`), so audio never leaves the machine.
- **Remote access.** The same workspace opens from a phone or another PC over Tailscale Serve.
  The remote listener checks the Tailscale identity on every request and an exact Origin on
  every write.
- **A second machine.** A Windows PC runs as a worker that the Mac updates, and it can serve a
  local model on its GPU for Claude Code terminals.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| Server | Hono with Hono RPC and zod, so the client and server share their types |
| Database | `bun:sqlite` with versioned SQL migrations and FTS5 search |
| Frontend | React 19, Vite, TanStack Router and TanStack Query |
| UI | Tailwind 4 and shadcn/ui |
| Terminals | xterm.js in the browser, a native PTY host on the server |
| Observability | OpenTelemetry traces stored locally, read with `bin/aos trace` |
| Quality | TypeScript 7, Biome, `bun test`, Playwright |

## How it is built

- Every architectural decision has an ADR in [`docs/adr/`](docs/adr), 16 so far, each with the
  options it rejected and why.
- 1,839 unit tests in 235 files and 44 Playwright end-to-end specs. `bun run check` runs the
  type check, Biome and the unit tests.
- Real data only: no mock data source ships, and a failed fetch shows as an error, never as an
  empty list.
- Secrets live in the macOS Keychain. GitHub calls go through `gh api`, so the token never
  leaves `gh`.
- No company data in the repository: project keys, repos and sites live in local config.

## Running it

It expects macOS, [Bun](https://bun.sh), the GitHub CLI signed in, and a Jira OAuth app for
the ticket features.

```sh
bun install
bun run build
bun run start   # http://localhost:4317
```

The guides cover the rest: [remote workspace](docs/remote-workspace.md),
[agent coordination](docs/coordination.md) and [voice](docs/voice.md).

## License

No license is granted. The code is public to read, and all rights are reserved.

Built by [Oriol Macias](https://oriolmacias.dev).
