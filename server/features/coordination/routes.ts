import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  ConsultationInput,
  ContextRef,
  MessageInput,
  Participant,
  ReserveInput,
} from "../../../shared/coordination.ts";
import { DATA_DIR, onGithub } from "../../config.ts";
import type { Services } from "../../deps.ts";
import { errorMessage } from "../../error-message.ts";
import type { Lifecycle } from "../../lifecycle.ts";
import { log } from "../../log.ts";
import { getComments, getIssue } from "../jira/issues.ts";
import { resolveAnyLocation } from "../projects/locations.ts";
import { listLocations } from "../terminals/harness.ts";
import { reviewPrompt, ticketPrompt } from "../terminals/ticket-prompt.ts";
import { capabilities, consultationArgs } from "./adapters.ts";
import { newAttempt } from "./runner.ts";
import { captureSnapshot } from "./snapshot.ts";
import { CoordinationError, reservePaths } from "./store.ts";

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new CoordinationError("bad_request", parsed.error.message, 400);
  return parsed.data;
}
export function coordinationRoutes(
  deps: Pick<
    Services,
    "config" | "terminals" | "jira" | "github" | "bus" | "coordination" | "messenger"
  >,
  {
    dir = join(DATA_DIR, "consultations"),
    inspect = capabilities,
    lifecycle,
  }: { dir?: string; inspect?: typeof capabilities; lifecycle?: Lifecycle } = {},
) {
  const { config, terminals, jira, github, bus, coordination: store, messenger } = deps;
  // The host owns running consultations; only server-owned preparation/delivery recover here.
  const reconcile = async () => store.reconcile(await terminals.list());
  const start = () => {
    store.recoverMessages();
    for (const q of store.consultations())
      if (q.state === "preparing")
        store.updateConsultation(q.id, (q) => ({
          ...q,
          state: "failed",
          error: "Server restarted during snapshot preparation. Prepare a new request.",
        }));
    return terminals.subscribe(() => {
      bus.publish("coordination");
      void reconcile().catch((err) =>
        log("coordination").error("reservation reconciliation failed", { err }),
      );
    });
  };
  lifecycle?.add(start);
  async function actor(c: Context) {
    const id = c.req.header("x-aos-agent-id");
    if (!id) return "user";
    const t = await terminals.get(id);
    if (t?.state !== "running" || !["claude", "codex", "grok"].includes(t.harness))
      throw new CoordinationError(
        "unknown_agent",
        "identity must name a running managed harness",
        403,
      );
    return t.id;
  }
  async function user(c: Context) {
    if ((await actor(c)) !== "user")
      throw new CoordinationError(
        "user_approval_required",
        "Review and approve this batch in Agents",
        403,
      );
  }
  async function contextText(refs: z.infer<typeof ContextRef>) {
    const parts: string[] = [];
    if (refs.ticket) {
      if (!config.providers.jira)
        throw new CoordinationError("provider_disabled", "Jira is disabled", 400);
      const [issue, comments] = await Promise.all([
        getIssue(jira, config, refs.ticket),
        getComments(jira, refs.ticket),
      ]);
      parts.push(ticketPrompt(issue, comments));
    }
    if (refs.pr) {
      const repo = config.repos.find((r) => r.id === refs.pr?.repo);
      if (!config.providers.github || !repo || !onGithub(repo))
        throw new CoordinationError("unknown_repo", "PR repository is not configured", 400);
      const pr = await github.pull(repo, refs.pr.number);
      const discussion = await github.discussion(repo, pr.number);
      parts.push(reviewPrompt(repo, pr, discussion.comments, undefined, discussion.truncated));
    }
    return parts.join("\n\n");
  }
  const needControl = () => {
    if (!terminals.consultations)
      throw new CoordinationError(
        "host_unavailable",
        "Consultations require an updated PTY host",
        503,
      );
    return terminals.consultations;
  };
  return new Hono()
    .get("/capabilities", async (c) =>
      c.json({
        version: 1,
        identity: "x-aos-agent-id / AOS_AGENT_ID (local attribution, not authentication)",
        adapters: await inspect(config, await terminals.env),
        endpoints: {
          self: "/api/coordination/self",
          summary: "/api/coordination",
          context: "/api/coordination/context",
          projects: "/api/projects",
          tickets: "/api/tickets",
          messages: "/api/coordination/messages",
          reservations: "/api/coordination/reservations",
          consultations: "/api/coordination/consultations",
          wait: "/api/coordination/wait",
        },
        limits: {
          participants: 3,
          defaultTimeoutMs: 600_000,
          automaticRetries: 0,
          reservationMode: "cooperative",
        },
      }),
    )
    .get("/self", async (c) => {
      const id = await actor(c);
      return c.json({ id, terminal: id === "user" ? null : await terminals.get(id) });
    })
    .get("/", async (c) => {
      await reconcile();
      return c.json({
        revision: store.revision(),
        agents: (await terminals.list())
          .filter((t) => ["claude", "codex", "grok"].includes(t.harness))
          .map((t) => ({
            id: t.id,
            harness: t.harness,
            state: t.state,
            name: t.name,
            location: t.location,
          })),
        messages: store
          .messages()
          .slice(0, 100)
          .map(({ text, ...m }) => ({ ...m, preview: text.slice(0, 160) })),
        reservations: store.reservations(),
        consultations: store.consultations().map((q) => ({
          id: q.id,
          author: q.author,
          createdAt: q.createdAt,
          state: q.state,
          prompt: q.input.prompt.slice(0, 240),
          location: q.input.location,
          attempts: q.attempts.map(({ result, usage, ...a }) => ({
            ...a,
            hasResult: Boolean(result),
          })),
        })),
        audit: store.audit(),
      });
    })
    .post("/context", async (c) => {
      const refs = await body(c, ContextRef);
      return c.json({ text: await contextText(refs), locations: listLocations(config) });
    })
    .get("/messages/:id", (c) => c.json(store.getMessage(c.req.param("id"))))
    .post("/messages", async (c) => {
      const from = await actor(c),
        input = await body(c, MessageInput);
      // An agent on another machine is checked there, when the message arrives.
      if (input.to !== "user" && !input.to.includes("@") && !store.existingMessage(from, input)) {
        const t = await terminals.get(input.to);
        if (!t || !["claude", "codex", "grok"].includes(t.harness))
          throw new CoordinationError("unknown_recipient", "Select a managed harness", 400);
      }
      const m = store.message(from, input);
      void messenger
        .deliver(m.id)
        .catch((err) => log("coordination").error("message delivery failed", { err }));
      return c.json(store.getMessage(m.id), 202);
    })
    .post("/reservations", async (c) => {
      const owner = await actor(c),
        input = await body(c, ReserveInput);
      const location = await resolveAnyLocation(config, await terminals.env, input.location);
      const t = owner === "user" ? undefined : await terminals.get(owner);
      return c.json(
        store.reserve(
          owner,
          t?.startedAt ?? "user",
          location.cwd,
          await reservePaths(location.cwd, input.paths),
          input.reason,
        ),
        201,
      );
    })
    .delete("/reservations/:id", async (c) => {
      const owner = await actor(c);
      const id = c.req.param("id");
      // The store ignores an unknown id; answering "released" then would hide a typo or a
      // shortened id, and the caller would go on believing the files are free.
      if (!store.reservations().some((r) => r.id === id))
        throw new CoordinationError("unknown_reservation", "no reservation has this full id", 404);
      store.release(owner, id);
      return c.json({ released: true });
    })
    .post("/consultations", async (c) => {
      const author = await actor(c),
        input = await body(c, ConsultationInput);
      const existing = store
        .consultations()
        .find((q) => q.author === author && q.input.requestId === input.requestId);
      if (existing)
        return c.json(
          store.createConsultation(author, input, existing.source, existing.contextText),
        );
      for (const p of input.participants) consultationArgs(p, "Validate launch options");
      const location = await resolveAnyLocation(config, await terminals.env, input.location);
      const context = [input.context, input.refs ? await contextText(input.refs) : ""]
        .filter(Boolean)
        .join("\n\n");
      const concurrent = store
        .consultations()
        .find((q) => q.author === author && q.input.requestId === input.requestId);
      if (concurrent)
        return c.json(
          store.createConsultation(author, input, concurrent.source, concurrent.contextText),
        );
      const q = store.createConsultation(author, input, location.cwd, context);
      try {
        const path = join(dir, q.id);
        await mkdir(path, { recursive: true, mode: 0o700 });
        const snapshot = join(path, "snapshot");
        const manifest = await captureSnapshot(
          location.cwd,
          snapshot,
          await terminals.env,
          config.git.bin ?? "git",
        );
        return c.json(
          store.updateConsultation(q.id, (q) =>
            q.state !== "preparing"
              ? q
              : {
                  ...q,
                  state: "pending",
                  snapshot,
                  fingerprint: manifest.fingerprint,
                  snapshotInfo: {
                    head: manifest.head,
                    files: manifest.files.length,
                    bytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
                    excluded: manifest.excluded,
                  },
                  attempts: input.participants.map((p) => newAttempt(p)),
                },
          ),
          201,
        );
      } catch (err) {
        store.updateConsultation(q.id, (q) => ({
          ...q,
          state: "failed",
          error: errorMessage(err),
        }));
        throw err;
      }
    })
    .get("/consultations/:id", (c) => c.json(store.getConsultation(c.req.param("id"))))
    .post("/consultations/:id/approve", async (c) => {
      await user(c);
      const control = needControl();
      const input = await body(
        c,
        z.object({ fingerprint: z.string(), attempts: z.array(z.string()).min(1).max(3) }),
      );
      const available = await inspect(config, await terminals.env);
      const q = store.updateConsultation(c.req.param("id"), (q) => {
        const queued = q.attempts.filter((a) => a.state === "queued");
        if (
          q.fingerprint !== input.fingerprint ||
          JSON.stringify(queued.map((a) => a.id).sort()) !==
            JSON.stringify([...input.attempts].sort())
        )
          throw new CoordinationError("batch_changed", "Review the current batch before approving");
        if (q.state !== "pending") throw new CoordinationError("not_pending", q.state);
        for (const a of queued)
          if (!available.find((c) => c.harness === a.participant.harness)?.available)
            throw new CoordinationError("adapter_unavailable", a.participant.harness, 503);
        return { ...q, state: "approved", approvedAt: new Date().toISOString() };
      });
      await control.start(q.id);
      return c.json(store.getConsultation(q.id));
    })
    .post("/consultations/:id/start", async (c) => {
      await user(c);
      const id = c.req.param("id");
      const q = store.getConsultation(id);
      if (q.state !== "approved" && q.state !== "running")
        throw new CoordinationError("not_approved", q.state);
      await needControl().start(id);
      return c.json(store.getConsultation(id));
    })
    .post("/consultations/:id/cancel", async (c) => {
      const who = await actor(c),
        q = store.getConsultation(c.req.param("id"));
      if (q.state === "preparing")
        throw new CoordinationError(
          "snapshot_preparing",
          "Wait for snapshot preparation before cancelling",
        );
      if (who !== "user" && who !== q.author)
        throw new CoordinationError("not_owner", "Only the author or user may cancel", 403);
      await needControl().cancel(q.id);
      return c.json(store.getConsultation(q.id));
    })
    .post("/consultations/:id/followup", async (c) => {
      const who = await actor(c);
      const input = await body(
        c,
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("retry"), attempt: z.string() }),
          z.object({ kind: z.literal("synthesis"), participant: Participant }),
        ]),
      );
      return c.json(
        store.updateConsultation(c.req.param("id"), (q) => {
          if (who !== "user" && who !== q.author)
            throw new CoordinationError(
              "not_owner",
              "Only the author or user may request another run",
              403,
            );
          if (!["finished", "cancelled"].includes(q.state))
            throw new CoordinationError("not_finished", q.state);
          if (
            input.kind === "synthesis" &&
            !q.attempts.some((a) => a.state === "succeeded" && a.kind === "opinion")
          )
            throw new CoordinationError("no_opinions", "No completed opinions to synthesize");
          const previous =
            input.kind === "retry"
              ? q.attempts.find(
                  (a) =>
                    a.id === input.attempt && !["succeeded", "queued", "running"].includes(a.state),
                )
              : undefined;
          if (input.kind === "retry" && !previous)
            throw new CoordinationError("not_retryable", "Pick an incomplete attempt");
          const participant =
            input.kind === "synthesis"
              ? input.participant
              : (previous as NonNullable<typeof previous>).participant;
          consultationArgs(participant, "Validate launch options");
          return {
            ...q,
            state: "pending",
            approvedAt: null,
            attempts: [
              ...q.attempts,
              newAttempt(participant, input.kind === "synthesis" ? "synthesis" : previous?.kind),
            ],
          };
        }),
      );
    })
    .delete("/consultations/:id", async (c) => {
      await user(c);
      const id = c.req.param("id"),
        input = await body(c, z.object({ confirm: z.string() }));
      if (input.confirm !== id)
        throw new CoordinationError("confirmation_required", "Confirm the consultation id", 400);
      const q = store.getConsultation(id);
      if (["running", "approved", "preparing"].includes(q.state))
        throw new CoordinationError("busy", "Cancel and wait for completion before deleting");
      await rm(join(dir, q.id), { recursive: true, force: true });
      store.removeConsultation(id);
      return c.json({ deleted: true });
    })
    .post("/wait", async (c) => {
      const input = await body(
        c,
        z.object({
          after: z.number().int().nonnegative(),
          timeoutMs: z.number().int().min(0).max(100_000).default(30_000),
        }),
      );
      const revision = await new Promise<number>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
          clearTimeout(timer);
          off();
          c.req.raw.signal.removeEventListener("abort", finish);
          resolve(store.revision());
        };
        const off = bus.subscribe((topic) => {
          if (topic === "coordination" && store.revision() > input.after) finish();
        });
        timer = setTimeout(finish, input.timeoutMs);
        c.req.raw.signal.addEventListener("abort", finish, { once: true });
        if (store.revision() > input.after || c.req.raw.signal.aborted) finish();
      });
      return c.json({ revision, reason: revision > input.after ? "changed" : "timeout" });
    });
}
