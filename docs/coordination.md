# Coordination with aos

Open **Agentes → Consultas / Mensajes / Reservas**. Existing Activity and Lanes views
remain available. A terminal's coordination link opens its messages and reservations.
New managed terminals have `aos` on PATH. From this checkout use `bin/aos`; older
sessions can use `bun scripts/aos.ts --agent <managed-terminal-id> …`.

`aos help`, `aos capabilities` and `aos self` describe the API and current identity.
JSON goes to stdout; failures go to stderr. Existing terminal commands are unchanged.
`AOS_URL` selects the app (default `http://localhost:4317`). Never point tests at the
user's production server. All examples below require an updated server and host.

## Messages and files

```sh
aos message send <recipient-id> --text-file message.txt --request-id unique-request-id
aos message list
aos message get <message-id>
aos message reply <message-id> --text-file reply.txt --request-id unique-reply-id
aos reserve --location repo:example --path src/api.ts --path src/types.ts --reason 'Implement API'
aos reservations
aos release <reservation-id>
```

Reuse the same request id when checking a message request after a network failure.
Do not create a new id to retry an uncertain delivery: inspect the terminal first.
A reply can come only from the recorded recipient. `user` is the human recipient.
Reservation conflicts name the owner and reason. All requested files are acquired
atomically. Orphaned reservations stay exclusive; the human can explicitly release
them from Agents. Reservations do not stop writes by an editor or uncooperative agent.

## Independent opinions

Prepare `batch.json` with `requestId`, a configured `location`, `prompt`,
`participants` (two distinct harnesses with explicit `harness` and `model`, optional
`effort`) and optional `timeoutMs` (10000–3600000, default 600000). Optional `context`
is plain text; `refs` can contain a Jira `ticket` or `pr: {repo, number}`. Provider
reads use the app's existing clients and propagate errors. Do not put credentials
in the prompt. Model identifiers must be available in the installed CLI.

```sh
aos consult prepare --input-file batch.json
aos consult list
aos consult get <consultation-id>
aos consult cancel <consultation-id>
aos coordination
aos events --after <revision> --timeout-ms 30000
```

Preparation captures the working tree but starts no model. Review the models,
limits, captured revision and excluded links in **Agentes → Consultas**; then use
**Aprobar y lanzar**. Successful answers remain visible when another participant
fails. An idle terminal is never used as proof that a consultation has completed.

`aos consult followup <id> --input-file followup.json` prepares one additional
attempt. The body is either `{ "kind": "retry", "attempt": "<failed-attempt-id>" }`
or `{ "kind": "synthesis", "participant": { "harness": "claude", "model": "<explicit-model>" } }`.
Both need a new UI approval. A requesting agent may also read the original answers
and synthesize them itself. **Borrar consulta** asks for confirmation and removes
saved local results and code; cancellation alone retains them.

`aos context --input-file refs.json` reads ticket/PR context without a launch and
returns configured locations. `aos capabilities` links to existing project and
ticket endpoints. Summary responses carry previews; get an individual message or
consultation for its full text. `aos events` waits for a durable revision change;
it does not poll model output.

See [ADR 0010](adr/0010-harness-coordination.md) for trust boundaries, storage,
adapters, deployment and verification limits.
