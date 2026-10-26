# ADR 0002 — Agent runs and their permissions

Status: accepted (2026-09-30); amended 2026-10-08 and 2026-10-16. The first amendment replaces the Agent SDK
decision, which is kept below as history.

## Amendment (2026-10-08): CLI harnesses, one permission table

Agents run as their own CLIs (`claude`, `codex`, `grok`): in terminals ([0003](0003-terminals.md))
and in consultations ([0010](0010-harness-coordination.md)). No feature ever ran on the Agent
SDK, so the SDK, its policy hook and `scripts/sdk-auth-proof.ts` are removed.

- `PERMISSIONS` in `shared/harness-capabilities.ts` is the one place permission flags are
  decided, by harness and mode. Terminals (`terminals/harness.ts`), ticket kickoff
  (`KICKOFF_PERMISSION`) and consultations (`coordination/adapters.ts`) only read it.
- `bypass`: a terminal. The local user opted into the CLI's bypass mode; it is not read-only,
  and its `cwd` is not a security boundary. Native managed policy and hooks still apply.
- `plan`: a new Claude session in plan mode, bypass one approval away. Codex and Grok: none.
- `consult`: a read-only consultation. Claude: `--restricted`, `dontAsk`, tools
  `Read,Glob,Grep`, no MCP, no setting sources, no slash commands. Codex: `--sandbox read-only`,
  no user config or rules, ephemeral, no multi-agent, no web search. Grok: not offered.
- A consultation also runs in a snapshot copy, with only the OS basics and its own harness's
  variables from the login environment (`consultationEnv`), behind the host lease
  (`worker.ts`), with 8 MiB of output at most. A CLI whose `--help` lacks a required flag is
  unavailable, never run with fewer.
- Never widen a `consult` entry or the consultation environment. A change to `bypass` or
  `plan` amends this ADR.

Verification (`server/features/coordination/adapters.test.ts`): every harness and mode takes
its flags from the table; a consultation gets no token but its harness's; losing the host
lease stops the process group.

## Amendment (2026-10-16): the mail categorizer proposes, the user's click applies

«Categorizar» in Inicio starts a Claude terminal (`bypass`, the scratch folder) on a saved
prompt (`server/features/mail/prompt.ts`). The agent reads through `aos mail profile|inbox` and
sends a proposal with `aos mail propose`. The server checks every mail against its own read of
the inbox and every folder against the account's own folders, and keeps the proposal. It never
applies anything on the agent's word.

- The gate is a native dialog. Applying, for Outlook and for Gmail alike, first shows the batch
  in AgenticMac's `NSAlert` («Mover 34 · Papelera 5») on the Mac's screen. Without the click,
  nothing moves. That is why `POST /api/mail/proposals/:id/apply` is a `desktop` route.
- `x-aos-agent-id` is attribution, not authentication. The apply route refuses a call that sends
  it, but an agent shell can call the route without it. What stops that call is the dialog: a
  click the agent cannot make.
- Moves and trash only. Outlook moves to the account's folders or to Elementos eliminados.
  Gmail calls `threads.modify` (add the label, remove `INBOX`) and `threads.trash`. Nothing is
  sent or deleted for good.
- Gmail's `gmail.modify` scope also allows sending (`users.messages.send` accepts it). The
  server calls only `threads.modify` and `threads.trash`. The scope is optional at consent:
  without it, reads go on and sorting asks for a reconnect before any dialog.
- What stays open: inside one macOS user there is no stronger boundary. Any process of that user
  can start AgenticMac or read the Keychain item, given its own prompts. The fixed operations,
  the recoverable trash and a log line per mail sorted, without its body (`mail: sorted`), are
  the mitigations.

Verification (`server/features/mail/mail.test.ts`):

- a proposal naming a mail outside the inbox, or a folder that does not exist, saves nothing;
- a call naming an agent cannot apply;
- a cancelled dialog leaves the proposal pending;
- Gmail without `gmail.modify` asks for a reconnect before the dialog.

## Amendment (2026-10-22): a recorded meeting's review starts on its own

When a recording's transcript is ready, the server starts a Claude terminal (`bypass`, the
scratch folder) on the prompt in `server/features/transcripts/review.ts`, with no click: the user
asked for it to run unattended and with full permissions, after being told the risk. The
terminal is visible: it sits in the Mesa «Reuniones» of the «Sistema» block. The agent reads
through `aos transcript show` and sends decisions, actions and things to remember with
`aos transcript propose`; the server checks the shape and keeps them in the recording's folder.

- Nothing is saved on the agent's word. Each item waits in the recording's tile until the user
  accepts it (an action becomes a task, the rest a line of the meeting's note) or discards it.
- The transcript is untrusted input: anyone in the call can say words that read as orders. The
  prompt names it data, never instructions. With `bypass`, an agent that obeys anyway can do
  whatever the user's shell can; that is the accepted risk.
- `x-aos-agent-id` is attribution: the accept route refuses a call that sends it, but there is
  no dialog behind it as with mail. An agent shell that drops the header can accept its own
  proposals. What that reaches is bounded: a task in the list or a line in a note, both visible
  and undone by hand.
- One run per recording (`agent.json` marks it); «Revisar otra vez» in the tile starts another.

Verification (`server/features/transcripts/review.test.ts`, `routes.test.ts`): the agent starts
once and only on a ready transcript; an accepted action is a task and a decision a note line; a
call naming an agent cannot decide; the prompt treats the transcript as data.

## Original decision (2026-09-30), replaced by the amendment

### Context

The first PoC launched agents that inherited the user's global Claude Code
permissions. The Agent SDK docs (code.claude.com/docs/en/agent-sdk/permissions
and …/claude-code-features, read 2026-09-30) establish:

- Hooks run first; a `PreToolUse` deny holds in every permission mode.
- `canUseTool` is skipped for auto-approved calls and never called in `dontAsk`.
- `allowedTools` pre-approves; it does not restrict the inventory. Bare-name
  `disallowedTools` removes a tool from the model's context.
- `settingSources: []` does not isolate `~/.claude.json`, managed policy or
  auto memory; `mcpServers: {}` does not remove claude.ai connectors.

### Decision

Every run uses:

- `tools: ["Read", "Glob", "Grep"]` and bare-name `disallowedTools` for every
  shell, write, delegation, web and MCP tool.
- `permissionMode: "dontAsk"`, `settingSources: []`, `strictMcpConfig: true`.
- A `PreToolUse` hook that denies any tool outside the allowlist and any path
  outside the run's configured repository.
- A minimal child `env`: OS basics, exactly one auth source
  (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), an app-owned
  `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- `cwd` from a configured repository id, never a client-supplied path.
- Ticket/PR context fetched by the app and placed in the prompt.
- Outcome read from the result message `subtype`, not from "no error".

"Read-only" means no change to repositories or external services. SDK session
files and the app's own run records are allowed writes.

### Verification

- The `init` message's tool list equals the allowlist; any extra tool fails the run.
- An adversarial prompt (write a file, run a command, spawn an agent) leaves the
  repository's file hashes unchanged.
- The hook log shows a deny for a read outside the repository.
