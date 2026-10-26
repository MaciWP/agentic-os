# ADR 0016 — Claude on the local model

Status: implemented and unit/e2e tested (2026-10-12); the live run on the PC's GPU is pending
its deploy and restarts. Supersedes P4 (a text-only MCP to the local model).

## Decision

A Claude terminal can run on the PC's own model instead of Anthropic's: the reserved model id
`local` (`LOCAL_MODEL` in `shared/harness-capabilities.ts`). Claude Code runs where the files
are, on the Mac or the PC; only the model runs on the PC's GPU. A local terminal is an ordinary
`claude` terminal, so `aos create/send/wait/read`, messages, the Mesa and the permission modes
of ADR 0003 work unchanged.

- **Engine**: `server/features/ai/engine.ts` (`AiEngine`) runs llama-server on `127.0.0.1` only,
  with the flags measured in the 2026-10-11 trial: Qwen3.8-27B with
  its MTP drafter, one slot, 128K context, no prompt logging. Configured by `ai.engine` in the
  PC's `data/config.json`; paths never go to git.
- **Optional and on demand**: the first request (or «Encender» in the system panel) starts it,
  about 9 s; it stops after `ai.engine.idleMinutes` (default 15) with no request in flight,
  freeing about 24.5 GB of VRAM. «Modo juego» stops it and refuses starts until turned off; it
  survives restarts (`data/ai-mode.json`).
- **One door**: `POST /api/ai/v1/*` (`server/features/ai/routes.ts`) forwards the Anthropic
  Messages API to the engine in streaming. The Mac reaches it through the hub's worker proxy,
  `/api/machines/<ai.machine>/ai/v1/*`, with its own 10-minute wait for headers
  (`AI_WAIT_MS` in `server/machines.ts`): with one slot, a queued request gets its headers only
  when the slot frees.
- **Terminal env** (`terminalEnv` in `server/features/terminals/harness.ts`), only for
  `claude` with model `local`: `ANTHROPIC_BASE_URL` (the door on this machine, or the hub's
  proxy to the worker named by `ai.machine`), `ANTHROPIC_AUTH_TOKEN=local` (an `ANTHROPIC_API_KEY` makes the interactive TUI
  stop to ask for approval), the three
  `ANTHROPIC_DEFAULT_*_MODEL=local`, `ANTHROPIC_CUSTOM_HEADERS` with this server's `Origin` (it
  passes `local-guard` as `aos` does), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
  `API_TIMEOUT_MS=600000`. The model id persists in `terminal_sessions.model`, so a resumed
  terminal stays local; no migration. No other terminal gets any `ANTHROPIC_*` variable.
- **Full Claude Code, not `--bare`**: Qwen's chat template raises on a system message mid
  conversation, which Claude Code sends. A patched copy turns it into a user turn wrapped in
  `<system-reminder>` and is loaded with `--chat-template-file` (`ai.engine.template`).
- **Thinking is capped in the engine** (`ai.engine.reasoningBudget`, `--reasoning-budget`): the
  model is unknown to Claude Code, so `--effort` and `MAX_THINKING_TOKENS` never reach it (same
  tokens with each). Measured 2026-10-13 on two blanked modules of this repo: unlimited, 72 s and
  209 s; 2048, 37 s and 84 s with the same tests and types passing and similar review findings;
  0, 317 s and 158 turns on the first with a test failing, and a loop on the second. On the
  six hard modules of Phase 0b, 2048 kept 6/6 tests and 5/6 clean types, median 132 s against
  158 s unlimited. The PC runs 2048; the default stays llama-server's unlimited.
- **Errors** come in the API's own shape with status 403 `permission_error`, so the terminal
  shows the reason (game mode, a failed start) and the SDK does not retry what a retry cannot
  fix (it retries 409 and 5xx). The control routes answer 409 in game mode and 503 otherwise.
- **Ownership**: only an engine this server started is stopped. Its pid is in
  `data/ai-engine.json`; a leftover is ended only when its command line names our binary and
  `--port <port>`. A port that already answers is someone else's: nothing is spawned.
- **Visible**: «IA local» in the system panel (state, queue, Encender/Apagar, Modo juego),
  «Claude local» in the Mesa's «Lanzar aquí» and as the terminal's kind label; the engine's own
  lines in `data/ai-engine.log`, listed in `/api/system/logs`.

## Rejected

- A text-only MCP to the local model (P4): the delegate could not read files or run tests.
- Tailscale Serve on a second port with an API key: a new ACL, a secret, and a public surface
  for a single user; the hub's proxy already carries the Tailscale identity and pairing token.
- `--bare` local terminals: they lose hooks, skills and `CLAUDE.md`; the template fixes the cause.
- Two slots without the drafter: MTP is the speed that makes the model usable; requests queue.
