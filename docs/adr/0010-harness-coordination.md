# ADR 0010 — Harness coordination

Status: implemented and locally verified; production rollout pending (2026-10-07).

## Decision

Extend the existing local HTTP API and `aos`, keeping coordination in the Agentes
screen. SQLite stores messages, reservations, consultations and release history.
The PTY host owns consultation execution and publishes changes through the existing
control socket and SSE topic. Interactive terminal launches retain their existing
policy; consultation adapters have separate read-only arguments.

New managed harness terminals receive `AOS_AGENT_ID`, `AOS_URL` and the repository's
`bin/aos` on PATH. Login environment cleanup removes inherited `AOS_*` values first.
An older session can pass `--agent <terminal-id>` explicitly. Only running managed
Claude/Codex/Grok terminals are valid agent identities. Shells use the human identity.

Identity is attribution, not authentication: ADR 0004's local single-user trust
boundary remains. Any process running as the OS user can impersonate local clients.
The workflow requires human approval in the UI and rejects approval carrying an
agent identity. This is not a security boundary against a malicious local process.
All public writes still pass `localGuard` and Zod. Agent launch permission remains
the user's decision; preparing a batch never starts a model.

## Messages and reservations

Messages have durable ids, sender, recipient, reply/thread links, timestamps and
idempotency keys. Changed input under the same key is refused. Sends serialize the
paste/Enter pair per recipient and never attach, interrupt or take over a window.
`delivered` records terminal input, not model completion. `answered` means a durable
reply exists. A transport failure after attempting input is `uncertain`; a server
restart recovers in-flight deliveries as uncertain and never resends them.

Reservations cover exact existing or new files, canonicalized inside a configured
location. Absolute paths, traversal, directories, metadata paths, escaping or dangling
symlinks are refused. SQLite immediate transactions claim the entire set or none.
The owner or human can release; releases retain an audit entry. A confirmed terminal
exit releases reservations. A lost session or changed generation leaves them orphaned
and exclusive. Human reservations persist until explicit release. These are
cooperative reservations, not filesystem locks.

## Consultation lifecycle

1. Prepare a prompt, location, optional ticket/PR context, two or three distinct
   harnesses with explicit models/optional effort and a per-response timeout.
2. Capture tracked and nonignored untracked files, including dirty changes. Record
   HEAD, diff, content hashes and excluded external links. Two content scans and
   before/after Git metadata must match. Limits: 512 MiB tree, 8 MiB diff/inventory.
   Source files are never changed. Internal symlinks are materialized; external
   targets are excluded and shown before approval. Every participant uses this copy.
3. The human approves the exact snapshot fingerprint and queued attempt ids. Default
   timeout: ten minutes per attempt; no automatic retries. Duplicate approvals cannot
   start another batch. A network error during launch requires inspecting state.
4. Fresh headless processes stream directly into bounded stdout/stderr capture,
   never xterm scrollback. Successful exit and a successful native final result are
   both mandatory. Keep per-attempt result, error, usage and raw output locally.
5. Cancellation and deadlines kill the isolated process group. A small supervisor
   holds an input-pipe lease: if the host dies, EOF kills the group. On host restart,
   unfinished approved/running attempts become interrupted; they never resume.
6. Retries and synthesis append attempts, retain original opinions and return to
   pending approval. They reuse the saved snapshot. Explicit confirmed deletion
   removes the consultation and its local snapshot/output; there is no timed cleanup.

Adapters check the installed CLI help for required flags without starting a model.
Claude uses restricted file tools (`Read,Glob,Grep`), no other settings, skills or
MCP servers, and `dontAsk`. Codex uses `exec`, read-only sandbox, ephemeral JSON
output, ignores user/project config and exec rules, disables multi-agent and web
search. Host policies may further restrict a launch; failures remain failures.
Grok is visible but unavailable: its isolation and final-output contract have not
been verified by this adapter. No fallback to permission bypass is allowed.

CLI references: [Claude](https://code.claude.com/docs/en/cli-reference),
[Codex](https://learn.chatgpt.com/docs/non-interactive-mode),
[Grok](https://docs.x.ai/build/cli/headless-scripting).

## Operations and verification

Migration `006_coordination.sql` is additive. Data lives under the configured data
directory (`consultations/<id>/`). Protocol 8 requires updating both server and PTY
host. The application refuses to replace an incompatible host with live terminals;
rollout waits for the user to stop them and restart the application. Merely refreshing
the frontend cannot deploy this backend change.

Unit/API tests cover identity, guard, atomic conflicts, idempotency, exact approval,
partial output, cancellation, timeout and recovery. Fixture executables exercise
native pipe capture and host-loss termination without calling a model. Isolated
browser tests cover approval/cancellation/results at 390 and 1280 px and a real
reservation/release request. The separately approved native acceptance batch passed
with Claude `haiku` and Codex `gpt-6-astra` (`low` effort): both returned the expected
sentinel from one synthetic snapshot, with successful native final results and exits.
The snapshot inventory and content hashes, and the original source content, remained
unchanged. Two starts, no retries, 120-second limit per response. This proves the
installed adapters' small read-only happy path, not resistance to adversarial prompts.
Evidence: `data/evidence/coordination/native-smoke-result.json` (local, ignored).
Grok remains disabled until its contract is implemented and verified.
