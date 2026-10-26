import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { compress } from "hono/compress";
import type { Connection } from "../shared/contracts.ts";
import { SERVER_ERRORS } from "./app-errors.ts";
import { type Deps, wire } from "./deps.ts";
import { errorHandler } from "./errors.ts";
import { aiRoutes } from "./features/ai/routes.ts";
import { clientErrorRoutes } from "./features/client-errors/routes.ts";
import { codeRoutes } from "./features/code/routes.ts";
import { workerMessageRoutes } from "./features/coordination/remote.ts";
import { coordinationRoutes } from "./features/coordination/routes.ts";
import { envRoutes } from "./features/envs/routes.ts";
import { eventRoutes } from "./features/events/routes.ts";
import { fileRoutes } from "./features/files/routes.ts";
import { gitRoutes } from "./features/git/routes.ts";
import { githubRoutes } from "./features/github/routes.ts";
import { googleReads, googleRoutes } from "./features/google/routes.ts";
import { imageRoutes } from "./features/images/routes.ts";
import { jiraAuthRoutes, ticketRoutes } from "./features/jira/routes.ts";
import { kickoffRoutes } from "./features/kickoff/routes.ts";
import { openCalendarSettings, startMail } from "./features/mac/outlook.ts";
import { macReads, macRoutes } from "./features/mac/routes.ts";
import { runMac } from "./features/mac/run.ts";
import { mailRoutes } from "./features/mail/routes.ts";
import { gmailSide, mailSorter, outlookSide } from "./features/mail/sort.ts";
import { meetingRoutes } from "./features/meetings/routes.ts";
import { memoryRoutes } from "./features/memory/routes.ts";
import { agentRoutes } from "./features/monitor/routes.ts";
import { objectiveRoutes } from "./features/objectives/routes.ts";
import { resolveAnyLocation } from "./features/projects/locations.ts";
import { projectRoutes } from "./features/projects/routes.ts";
import { scanRepos } from "./features/projects/worktrees.ts";
import { systemRoutes } from "./features/system/routes.ts";
import { receivedVersion } from "./features/system/update.ts";
import { typeImage } from "./features/terminals/paste-image.ts";
import { terminalRoutes } from "./features/terminals/routes.ts";
import { configOrigins } from "./features/terminals/ws-guard.ts";
import { transcriptRoutes } from "./features/transcripts/routes.ts";
import { usageRoutes } from "./features/usage/routes.ts";
import { keepDictations } from "./features/voice/eval-capture.ts";
import { normalize } from "./features/voice/normalize.ts";
import { voiceRoutes } from "./features/voice/routes.ts";
import {
  workboardActor,
  workboardContext,
  workboardReleased,
} from "./features/workboard/context.ts";
import { workboardRoutes } from "./features/workboard/routes.ts";
import { workspaceRoutes } from "./features/workspace/routes.ts";
import { localGuard, servedPorts } from "./local-guard.ts";
import { log } from "./log.ts";
import { machineRoutes } from "./machines.ts";
import { isRemoteRequest } from "./remote-access.ts";
import { remoteAllowlist } from "./remote-routes.ts";
import { getSecret } from "./secrets.ts";
import { traceRequests } from "./telemetry/http.ts";
import { telemetryRoutes } from "./telemetry/routes.ts";
import { markError, traceId } from "./telemetry/span.ts";

// Requests a session sends on a timer to say it is alive.
const HEARTBEATS = new Set(["/api/workboard/session"]);
// A read slower than this leaves a line too, so a slow page has a history to look at.
const SLOW_READ_MS = 1_000;

// The `error` and `detail` of a failed JSON answer, so its log line says why. Other bodies (a
// stream, a page) are not read.
async function failureOf(res: Response): Promise<{ error?: string; detail?: string } | null> {
  if (!res.headers.get("content-type")?.includes("application/json")) return null;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown; detail?: unknown } | null;
  if (!body || typeof body !== "object") return null;
  const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  return {
    error: typeof body.error === "string" ? body.error : undefined,
    detail: detail?.slice(0, 300),
  };
}

type ConnectionRow = {
  provider: string;
  account_id: string;
  display_name: string | null;
  site_url: string | null;
};

export function createApp(input: Deps) {
  const deps = wire(input);
  const { config, db, memory, github, images, sessions, usage, bus, envs, kickoffs } = deps;
  const { tickets, team, boards, projectsChanged, background: lifecycle } = deps;
  const jobs = deps.envJobs;
  // The inboxes are kept on disk, so a restarted server shows Inicio's mail at once.
  const { dataDir } = deps.memoryRoots;
  const gmail = googleReads(db, () => bus.publish("google"), join(dataDir, "inbox-gmail.json"));
  const outlook = macReads(
    runMac,
    startMail,
    () => bus.publish("mac"),
    join(dataDir, "inbox-outlook.json"),
  );
  const google = googleRoutes(deps, gmail);
  const version = deps.update ? receivedVersion(deps.update.dataDir) : null;
  const guard = localGuard(
    servedPorts(config.port, config.devPort, process.env.NODE_ENV === "production"),
    config.remote.enabled ? config.remote.origin : undefined,
  );

  const app = new Hono()
    // JSON only: a remote device on mobile data gets a fraction of the bytes, while the events
    // stream and the terminals' WebSockets pass untouched. Outermost, so the request line below
    // still reads a failure's body as it was written.
    .use("/api/*", compress({ contentTypeFilter: /^application\/json/ }))
    // One span per request (server/telemetry): inside compress, so its time is not counted.
    .use("*", traceRequests())
    .use("*", async (c, next) => {
      const id = crypto.randomUUID();
      const started = performance.now();
      c.header("x-request-id", id);
      trace.getActiveSpan()?.setAttribute("request.id", id);
      const tid = traceId();
      if (tid) c.header("x-trace-id", tid);
      await next();
      // Changes, failures and slow reads only, by path: a query can carry an OAuth code. A
      // heartbeat repeats every few seconds per session, so only its server failures are kept.
      // A stream (events, a WebSocket) stays open by design, so it is never slow.
      const { method } = c.req;
      const { status } = c.res;
      const ms = Math.round(performance.now() - started);
      const quiet =
        method === "GET" || method === "HEAD" || method === "OPTIONS" || HEARTBEATS.has(c.req.path);
      const stream =
        status === 101 || c.res.headers.get("content-type")?.startsWith("text/event-stream");
      const slow = method === "GET" && ms >= SLOW_READ_MS && !stream;
      if (status < 500 && quiet && !slow) return;
      const cause = status >= 500 ? await failureOf(c.res) : null;
      if (cause?.error && cause.error !== "machine_offline")
        markError(
          cause.detail?.startsWith(cause.error)
            ? cause.detail
            : [cause.error, cause.detail].filter(Boolean).join(": "),
        );
      // A worker held down already said so once, in its `machines` line.
      if (cause?.error === "machine_offline") return;
      const fields = { ms, request: id, ...cause };
      log("http")[status >= 500 ? "error" : "info"](`${method} ${c.req.path} ${status}`, fields);
    })
    .use("/api/*", guard)
    .use("/auth/*", guard)
    .use("*", remoteAllowlist())
    .get("/api/access", (c) =>
      c.json({ remote: isRemoteRequest(c.req.raw), desktop: !isRemoteRequest(c.req.raw) }),
    )
    .get("/api/health", (c) => {
      const row = db.query<{ ok: number }, []>("SELECT 1 AS ok").get();
      // The pid tells a page waiting on a restart that another server answers.
      // A worker's version: what the hub compares with its own code.
      return c.json({ ok: row?.ok === 1, pid: process.pid, version });
    })
    .get("/api/connections", async (c) => {
      // A disabled provider is not a connection to fix, so it is not listed.
      const connections: Connection[] = [
        ...(config.jira
          ? [{ ...(await oauthStatus(db, "atlassian")), project: config.jira.project }]
          : []),
        ...(config.providers.google ? [await oauthStatus(db, "google")] : []),
      ];
      return c.json({ connections });
    })
    .route(
      "/auth/atlassian",
      jiraAuthRoutes(deps, {
        invalidate: () => {
          tickets.invalidate();
          team.invalidate();
          boards.invalidate();
        },
      }),
    )
    .route("/auth/google", google.auth)
    .route("/api/google", google.api)
    .route("/api/mac", macRoutes(deps, outlook, openCalendarSettings))
    .route(
      "/api/mail",
      mailRoutes({
        config,
        proposals: deps.proposals,
        sorter: mailSorter(deps.proposals, {
          work: outlookSide(outlook),
          personal: gmailSide(gmail, outlook.client.confirm, db),
        }),
      }),
    )
    .route("/api/workspace", workspaceRoutes(deps.workspace))
    .route("/api/objectives", objectiveRoutes(deps))
    .route("/api/meetings", meetingRoutes(deps))
    .route("/api/transcripts", transcriptRoutes(deps))
    .route("/api/events", eventRoutes(bus))
    .route(
      "/api/workboard",
      workboardRoutes({
        store: deps.workboard,
        context: workboardContext(config, deps.terminals, envs),
        actor: workboardActor(deps.terminals),
        released: workboardReleased(deps.terminals),
      }),
    )
    .route(
      "/api/coordination/remote",
      workerMessageRoutes({
        store: deps.coordination,
        messenger: deps.messenger,
        dataDir: deps.update?.dataDir,
      }),
    )
    .route("/api/coordination", coordinationRoutes(deps, { lifecycle }))
    .route("/api/tickets", ticketRoutes(deps, tickets, team, boards))
    .route("/api/terminals", terminalRoutes(deps, { memory, github, images }))
    .route(
      "/api/images",
      imageRoutes(images, {
        shoot: deps.capture,
        clipboard: deps.clipboard,
        hotkey: deps.hotkey,
        typeInto: (terminal, path) => typeImage(deps.terminals, terminal, path),
      }),
    )
    .route(
      "/api/voice",
      voiceRoutes(
        deps.voice ?? null,
        (text) =>
          normalize(text, { replace: config.voice.replace, jiraProject: config.jira?.project }),
        {
          keep: deps.voiceEvalDir ? keepDictations(deps.voiceEvalDir) : undefined,
          capture: config.voice,
        },
      ),
    )
    .route("/api/envs", envRoutes(deps, jobs))
    .route("/api/kickoff", kickoffRoutes(kickoffs))
    .route("/api/projects", projectRoutes(deps, envs, projectsChanged))
    .route("/api/files", fileRoutes(deps.config))
    .route("/api/code", codeRoutes(deps, { envs, locate: resolveAnyLocation }, bus))
    .route(
      "/api/git",
      gitRoutes(deps, { envs, locate: resolveAnyLocation, scan: scanRepos }, projectsChanged),
    )
    .route("/api/agents", agentRoutes(deps, sessions))
    .route("/api/system", systemRoutes(deps))
    .route("/api/ai", aiRoutes(deps.ai ?? null, config.ai?.machine ?? null))
    .route("/api/machines", machineRoutes(config.machines, configOrigins(config), deps.machineCode))
    .route("/api/client-errors", clientErrorRoutes())
    .route("/api/telemetry", telemetryRoutes())
    .route("/api/memory", memoryRoutes(memory))
    .route("/api/usage", usageRoutes(deps, usage))
    .route("/api/github", githubRoutes(github, config))
    .onError(errorHandler(SERVER_ERRORS));
  return Object.assign(app, { start: () => lifecycle.start(), dispose: () => lifecycle.dispose() });
}

const OAUTH_SECRETS = {
  atlassian: ["atlassian.tokens", "atlassian.client_id", "atlassian.client_secret"],
  google: ["google.tokens", "google.client_id", "google.client_secret"],
} as const;

// Connected means both who (the row) and the tokens (the Keychain); without the app's own
// credentials there is nothing to connect with yet.
async function oauthStatus(
  db: Database,
  provider: keyof typeof OAUTH_SECRETS,
): Promise<Connection> {
  const [tokens, id, secret] = OAUTH_SECRETS[provider];
  const row = db
    .query<ConnectionRow, [string]>(
      "SELECT provider, account_id, display_name, site_url FROM connections WHERE provider = ?",
    )
    .get(provider);
  if (row && (await getSecret(tokens)))
    return { provider, status: "connected", account: row.display_name, detail: row.site_url };
  const hasApp = (await getSecret(id)) && (await getSecret(secret));
  return {
    provider,
    status: hasApp ? "not_connected" : "missing_credentials",
    account: null,
    detail: hasApp ? null : `Run bun run secrets:set ${id} / ${secret}`,
  };
}

export type AppType = ReturnType<typeof createApp>;
