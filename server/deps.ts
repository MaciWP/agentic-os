import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cached } from "./cache.ts";
import { APP_ROOT, type Config, DATA_DIR, loadConfig } from "./config.ts";
import { errorMessage } from "./error-message.ts";
import { AgentTracker, withAgents } from "./features/agents/state.ts";
import { AiEngine, aiPaths } from "./features/ai/engine.ts";
import { Messenger } from "./features/coordination/messages.ts";
import { hubMessages, POLL_MS, workerRemote } from "./features/coordination/remote.ts";
import { CoordinationStore } from "./features/coordination/store.ts";
import { EnvJobs } from "./features/envs/jobs.ts";
import { listEnvs } from "./features/envs/provider.ts";
import { EventBus } from "./features/events/bus.ts";
import { GitError, runGit } from "./features/git/run.ts";
import { updateRepos } from "./features/git/sync.ts";
import { type GithubClient, githubClient } from "./features/github/prs.ts";
import type { Captured } from "./features/images/capture.ts";
import { ClipboardWatch, type WatchState } from "./features/images/clipboard-watch.ts";
import { CaptureHotkey } from "./features/images/hotkey.ts";
import { imageStore } from "./features/images/sources.ts";
import type { ImageStore } from "./features/images/store.ts";
import { type JiraClient, jiraClient } from "./features/jira/client.ts";
import { boardLoader, teamLoader, ticketLoader } from "./features/jira/routes.ts";
import { Kickoffs } from "./features/kickoff/run.ts";
import { seedSortPrompts } from "./features/mail/prompt.ts";
import { ProposalStore } from "./features/mail/store.ts";
import { MeetingStore } from "./features/meetings/store.ts";
import { seedMiner } from "./features/memory/miner-prompt.ts";
import { memorySources, type SourceRoots } from "./features/memory/sources.ts";
import { MemoryStore } from "./features/memory/store.ts";
import { ObjectiveStore, withObjectives } from "./features/objectives/store.ts";
import { envCache, reloadEnvs, watchEnded } from "./features/projects/routes.ts";
import { type SessionSources, userSessionSources } from "./features/sessions/scan.ts";
import { AWAKE_ENV, KeepAwake } from "./features/system/keep-awake.ts";
import type { HostInfo } from "./features/system/system.ts";
import { applyBundle, appVersion, packBundle, UPDATES_ENV } from "./features/system/update.ts";
import type { Terminals } from "./features/terminals/contract.ts";
import { Drafts } from "./features/terminals/drafts.ts";
import { loadLoginEnv, loginEnvLoader } from "./features/terminals/env.ts";
import { HostClient } from "./features/terminals/host-client.ts";
import { withModels } from "./features/terminals/models.ts";
import { AttachTokens } from "./features/terminals/ws-guard.ts";
import { livePorts, missingPieces } from "./features/transcripts/live.ts";
import { placeInSistema, Review } from "./features/transcripts/review.ts";
import { Transcripts } from "./features/transcripts/runner.ts";
import { TranscriptStore } from "./features/transcripts/store.ts";
import { grokUsageCli } from "./features/usage/grok.ts";
import { USAGE_EVERY_MS, UsageIngest } from "./features/usage/ingest.ts";
import {
  claudeJudge,
  EffortJudge,
  JUDGE_CHECK_MS,
  type JudgeAsk,
  JudgeStore,
} from "./features/usage/judge.ts";
import { samplePlans } from "./features/usage/plan-samples.ts";
import { VoiceEngine } from "./features/voice/engine.ts";
import { glossary } from "./features/voice/normalize.ts";
import { WorkboardStore } from "./features/workboard/store.ts";
import { WorkspaceStore } from "./features/workspace/store.ts";
import { hostPaths, isHostPid, readHostFile } from "./host/files.ts";
import { connectHost } from "./host/launch.ts";
import { Lifecycle } from "./lifecycle.ts";
import { log, makePrivate, rotate } from "./log.ts";
import { machineTokens } from "./machine-tokens.ts";
import type { MachineOptions } from "./machines.ts";
import { Restarter, rebuildWeb, startupProblem, stopHost, supervisedBy } from "./restart.ts";
import { keepRoute, peerReader, ROUTE_CHECK_MS, tailscaleBin, tailscaleExec } from "./tailscale.ts";

// What the server is built from. The four first are required; every other one is built by
// `wire` when it is left out, so a test passes only the fakes it needs.
export type Deps = {
  config: Config;
  db: Database;
  terminals: Terminals;
  tokens: AttachTokens;
  memoryRoots?: SourceRoots;
  memory?: MemoryStore;
  jira?: JiraClient;
  github?: GithubClient;
  // Where external sessions are scanned from; the user's home by default.
  sessions?: SessionSources;
  // Where pasted images are kept; data/pastes by default.
  pastesDir?: string;
  // The image history; by default the pasted images and the screenshots folder.
  images?: ImageStore;
  // "Capturar": the OS's selection on screen; tests answer for it.
  capture?: () => Promise<Captured>;
  // "Añadir repo": the config file it writes; tests give their own.
  configPath?: string;
  // The clipboard watcher's state, shown in the history; off when absent.
  clipboard?: () => WatchState;
  // ⌃⌘4's resident helper; absent in tests, so none starts one.
  hotkey?: CaptureHotkey;
  // Reads the harness transcripts into the usage tables; the server runs it on a timer.
  usage?: UsageIngest;
  // The effort judge's one call to Sonnet; only the real server has one, so no test spends.
  judgeAsk?: JudgeAsk;
  envJobs?: EnvJobs;
  // The PTY host and the sleep guard, for the top bar's system indicator. The server
  // wires them; tests leave them out, so no unit test starts caffeinate.
  hostInfo?: () => Promise<HostInfo | null>;
  keepAwake?: KeepAwake;
  // What each terminal works on; the real server shares it with the agent tracker.
  objectives?: ObjectiveStore;
  // Dictation; absent when config.json names no speech model.
  voice?: VoiceEngine;
  // Meeting recordings and their transcripts; by default the real helper, models and clock.
  transcripts?: Transcripts;
  // Where dictations are kept for the real-voice test set, when `voice.evalCapture` is on.
  voiceEvalDir?: string;
  // The local model for Claude terminals; only on the machine whose config has ai.engine.
  ai?: AiEngine;
  // «Reiniciar» in the system indicator; only the real server, under its supervisor, has one.
  restart?: Restarter;
  // A worker's «Actualizar» from the hub: where its pairing is kept, and how a bundle lands.
  update?: WorkerUpdate;
  // The hub's side of it: its code and each worker's pairing token.
  machineCode?: Pick<MachineOptions, "code" | "tokens" | "peer">;
  // What `GET /api/system/logs` shows: the server's, the PTY host's and the Windows launcher's.
  logs?: string[];
};

export type WorkerUpdate = {
  dataDir: string;
  apply: (bundle: Uint8Array, version: string) => Promise<string | null>;
};

// How often the server itself checks the lists nothing tells it about, while a dashboard
// is open.
const TICKETS_EVERY_MS = 5 * 60_000;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_ROTATE_EVERY_MS = 10 * 60_000;

// The one place the server's services are built and their background work is listed (the PTY
// host has server/host/main.ts). Features receive them and never build their own;
// server/composition.test.ts holds that. A service already in `deps` is kept, so a test passes
// only the fakes it needs.
function build(deps: Deps) {
  const { config, db } = deps;
  const objectives = deps.objectives ?? new ObjectiveStore(db);
  const terminals = withObjectives(deps.terminals, objectives);
  const memoryRoots = deps.memoryRoots ?? {
    home: homedir(),
    dataDir: DATA_DIR,
    repos: config.repos,
  };
  const jira = deps.jira ?? jiraClient(db);
  const github = deps.github ?? githubClient(config, { onChange: () => bus.publish("prs") });
  const memory =
    deps.memory ?? new MemoryStore(db, memorySources(memoryRoots), memoryRoots.dataDir);
  const envJobs = deps.envJobs ?? new EnvJobs({ config, terminals });
  const tickets = ticketLoader({ config, jira });
  const bus = new EventBus([
    {
      topic: "prs",
      everyMs: 60_000,
      // The inbox reloads itself behind a read past its TTL and pushes what changed.
      load: () => (config.providers.github ? github.list() : Promise.resolve(null)),
    },
    {
      topic: "tickets",
      everyMs: TICKETS_EVERY_MS,
      load: ({ baseline }) => tickets.get({ fresh: !baseline }),
    },
  ]);
  const coordination = new CoordinationStore(db, () => bus.publish("coordination"));
  // Messages to `agent@machine`: the hub hands them over and collects replies; a worker holds
  // them for the hub (features/coordination/remote.ts).
  const mail =
    config.role === "hub" && config.machines.length > 0
      ? hubMessages({ machines: config.machines, tokens: machineTokens, store: coordination })
      : undefined;
  const messenger = new Messenger(
    coordination,
    terminals,
    undefined,
    config.role === "worker" ? workerRemote : mail && { held: () => false, relay: mail.relay },
  );
  const envs = envCache(config, terminals);
  const projectsChanged = () => bus.publish("projects");
  const kickoffs = new Kickoffs({
    config,
    jira,
    github,
    memory,
    terminals,
    jobs: envJobs,
    listEnvs: async () => (config.envs ? listEnvs(config.envs, await terminals.env) : []),
    hostInfo: deps.hostInfo,
    dataDir: memoryRoots.dataDir,
    git: async (cwd, args) => {
      if (!config.git.bin) throw new GitError("no git binary configured");
      const env = await terminals.env;
      return (await runGit(config.git.bin, cwd, args, { env, timeoutMs: 30_000 })).out;
    },
  });
  // The services' work outside any request; createApp starts and stops it.
  const background = new Lifecycle();
  background.add(() =>
    envJobs.changes.add((job) => {
      bus.publish("envjobs");
      // A job that ended may have created, started, stopped or removed an env.
      if (job.state !== "running") void reloadEnvs(envs, projectsChanged);
    }),
  );
  background.add(() => kickoffs.changes.add(() => bus.publish("kickoff")));
  // Off by default: a network job on the server's own clock, never a browser poll.
  background.add(() => {
    if (config.git.autoUpdateMinutes <= 0) return;
    const timer = setInterval(() => {
      updateRepos(config, terminals)
        .then((items) => {
          for (const i of items) {
            if (i.result !== "up_to_date") {
              log("git").info(`auto-update ${i.location}: ${i.result} ${i.detail ?? i.commits}`);
            }
          }
          projectsChanged();
        })
        .catch((err) => log("git").error("auto-update failed", { err }));
    }, config.git.autoUpdateMinutes * 60_000);
    timer.unref();
    return () => clearInterval(timer);
  });
  const ended = watchEnded(terminals, envs, projectsChanged);
  background.add(() =>
    terminals.subscribe(() => {
      bus.publish("terminals");
      void ended().catch((err) => log("terminals").error("reconciliation failed", { err }));
    }),
  );
  background.add(() => () => bus.dispose());
  const meetings = new MeetingStore(db);
  const workspace = new WorkspaceStore(db, () => bus.publish("workspace"));
  const transcripts = deps.transcripts ?? transcriptsFor(config, db, deps.voice);
  const review = new Review({
    recording: (id) => transcripts.get(id),
    meetings,
    memory,
    addTask: (goal) => objectives.addTask(goal),
    launch: (spec) => terminals.create(spec),
    workspace,
    appRoot: APP_ROOT,
  });
  return {
    ...deps,
    terminals,
    // As the host reports them, each with the ticket it was launched with: what the objective
    // store's own writes need, never the effective ticket it decorates `terminals` with.
    launched: deps.terminals,
    objectives,
    meetings,
    proposals: new ProposalStore(db, () => bus.publish("mail")),
    transcripts,
    review,
    memoryRoots,
    memory,
    jira,
    github,
    images:
      deps.images ??
      imageStore(deps.pastesDir ?? join(DATA_DIR, "pastes"), config.images.screenshotsDir),
    sessions: deps.sessions ?? userSessionSources(),
    usage:
      deps.usage ??
      new UsageIngest({ db, home: homedir(), grokUsage: grokUsageCli(config.terminals.bins.grok) }),
    judge: new EffortJudge(new JudgeStore(db), homedir(), deps.judgeAsk ?? null),
    envJobs,
    bus,
    tickets,
    team: teamLoader({ config, jira }, { onChange: () => bus.publish("tickets") }),
    boards: boardLoader({ config, jira }),
    envs,
    projectsChanged,
    workspace,
    workboard: new WorkboardStore(join(memoryRoots.dataDir, "workboard-sessions.json")),
    // The images in each terminal's Claude draft, as its hud mod reports them.
    drafts: new Drafts(),
    coordination,
    messenger,
    mail,
    kickoffs,
    background,
  };
}

function transcriptsFor(config: Config, db: Database, voice: VoiceEngine | undefined) {
  const app = join(DATA_DIR, "bin", "AgenticAudio.app");
  return new Transcripts(
    new TranscriptStore(db),
    livePorts(config.transcripts, voice, undefined, app),
    {
      root: join(DATA_DIR, "transcripts"),
      app,
      bundle: config.transcripts.bundle,
      missing: () => missingPieces(config.transcripts, voice, app),
      pollMs: 5_000,
      graceMs: 30_000,
      now: Date.now,
      id: () => crypto.randomUUID(),
    },
  );
}

export type Services = ReturnType<typeof build>;

// Services that went through here come back as they are: serverRoot builds, then createApp.
export const wire = (deps: Deps | Services): Services => ("bus" in deps ? deps : build(deps));

// What the process hands the root: a restart quiesces the server, then stops it.
export type ProcessExit = { quiesce: () => void; stop: () => Promise<void> };

// The real server's services: the PTY host client, the agent tracker, the sleep guard, voice,
// the restarter and the clipboard watcher on top of `build`, with their background work
// (usage ingest, log rotation) on the same list.
// The hub's code version, read again at most every few seconds: the machine list polls it.
const hubVersion = cached(async () => appVersion(APP_ROOT), { ttlMs: 10_000 });

export function serverRoot(config: Config, db: Database, exit: ProcessExit): Services {
  const loginEnv = loginEnvLoader(() => loadLoginEnv(config.terminals.shell));
  const host = new HostClient(() => connectHost(DATA_DIR), loginEnv);
  const objectives = new ObjectiveStore(db);
  const agents = new AgentTracker(host, {
    home: homedir(),
    db,
    onSession: (t, sessionId) => objectives.freeze(t, sessionId),
  });
  const terminals = withAgents(withModels(host, db), agents);
  const keepAwake = new KeepAwake({
    screenWhileAgentsWork: config.system.screenWhileAgentsWork,
    remoteHeld: process.env[AWAKE_ENV] === "1",
  });
  const tailscale = config.remote.enabled ? tailscaleBin() : null;
  const voice = config.voice.model
    ? new VoiceEngine(config.voice.model, {
        idleMs: config.voice.idleMinutes * 60_000,
        words:
          config.voice.boost > 0
            ? {
                terms: glossary({ ...config.voice, jiraProject: config.jira?.project }),
                boost: config.voice.boost,
              }
            : {},
      })
    : undefined;
  // Which model the voice lines come from, when two are installed to compare.
  if (config.voice.model) log("voice").info(`model ${basename(config.voice.model)}`);
  const ai = config.ai?.engine ? new AiEngine(config.ai.engine, { dataDir: DATA_DIR }) : undefined;
  const services = build({
    config,
    db,
    terminals,
    objectives,
    tokens: new AttachTokens(),
    hostInfo: () => host.hostInfo(),
    keepAwake,
    voice,
    voiceEvalDir: config.voice.evalCapture ? join(DATA_DIR, "voice-eval") : undefined,
    ai,
    judgeAsk: claudeJudge(() => config, loginEnv, join(DATA_DIR, "judge")),
    restart: new Restarter({
      supervised: () => supervisedBy(join(DATA_DIR, "supervisor.pid")),
      preflight: () => startupProblem(APP_ROOT, loadConfig),
      quiesce: () => exit.quiesce(),
      hostPid: () => readHostFile(hostPaths(DATA_DIR).file)?.pid ?? null,
      isHostPid,
      stopHost: async (pid) => {
        const found = readHostFile(hostPaths(DATA_DIR).file);
        return found?.pid === pid && (await stopHost(found));
      },
      sleep: (ms) => Bun.sleep(ms),
      rebuildWeb: () => rebuildWeb(APP_ROOT),
      exit: () => exit.stop(),
      log: (line) => log("restart").info(line),
    }),
    logs: [
      join(DATA_DIR, "server.log"),
      hostPaths(DATA_DIR).log,
      join(DATA_DIR, "launcher.log"),
      aiPaths(DATA_DIR).log,
    ],
    machineCode:
      config.role === "hub" && config.machines.length > 0
        ? {
            code: {
              version: () => hubVersion.get(),
              bundle: () => packBundle(APP_ROOT, join(DATA_DIR, "bundle")),
            },
            tokens: machineTokens,
            peer: tailscale ? peerReader(tailscaleExec(tailscale)) : undefined,
          }
        : undefined,
    update:
      config.role === "worker"
        ? {
            dataDir: DATA_DIR,
            apply: (bundle, version) =>
              applyBundle(bundle, version, {
                appRoot: APP_ROOT,
                dataDir: DATA_DIR,
                preflight: (root) => startupProblem(root, loadConfig),
                log: (line) => log("update").info(line),
                managed: process.env[UPDATES_ENV] === "1",
              }),
          }
        : undefined,
  });
  const { images, usage, background } = services;
  background.add(() => {
    seedMiner(services.memory, APP_ROOT, services.memoryRoots.dataDir).catch((err) =>
      log("memory").error("could not seed the miner prompt", { err }),
    );
    seedSortPrompts(services.memory, APP_ROOT).catch((err) =>
      log("mail").error("could not seed the mail sort prompts", { err }),
    );
  });
  const clipboard = new ClipboardWatch((bytes) => images.save(bytes));
  const hotkey = new CaptureHotkey({ port: config.port });
  background.add(() => {
    host.warm();
    return () => host.close();
  });
  const hub = config.role === "hub";
  const { mail, messenger } = services;
  if (mail)
    background.add(() => {
      // Every POLL_MS; a failure is logged once until it changes, not on every round while the
      // worker is off.
      let running = false;
      let failing = "";
      const collect = () => {
        if (running) return;
        running = true;
        mail
          .collect(messenger)
          .then(() => {
            failing = "";
          })
          .catch((err) => {
            const why = errorMessage(err);
            if (why !== failing) log("coordination").warn(`collecting worker messages: ${why}`);
            failing = why;
          })
          .finally(() => {
            running = false;
          });
      };
      const timer = setInterval(collect, POLL_MS);
      timer.unref();
      return () => clearInterval(timer);
    });
  // The Serve route the other devices come in by, checked every ROUTE_CHECK_MS: one CLI call
  // while it is there, put back when it is lost. A change is logged once, not every round.
  if (config.remote.enabled && !tailscale)
    log("tailscale").warn("remote access is on, but no Tailscale CLI was found");
  if (tailscale)
    background.add(() => {
      log("tailscale").info(`checking the Serve route every ${ROUTE_CHECK_MS / 1000} s`);
      const exec = tailscaleExec(tailscale);
      const ports = { local: config.port, remote: config.remote.port };
      let running = false;
      let last = "ready";
      const check = () => {
        if (running) return;
        running = true;
        keepRoute(exec, ports)
          .then((step) => {
            if (step.do === "restored")
              log("tailscale").warn(`Serve route was gone; restored to 127.0.0.1:${ports.remote}`);
            const now =
              step.do === "stop"
                ? step.reason
                : step.do === "up"
                  ? "Tailscale is stopped; the route waits for it"
                  : step.do === "restored"
                    ? "ready"
                    : step.do;
            if (now !== last && step.do !== "wait")
              log("tailscale")[now === "ready" ? "info" : "warn"](`Serve route: ${now}`);
            last = now;
          })
          .catch((err) => {
            const why = errorMessage(err);
            if (why !== last) log("tailscale").warn(`checking the Serve route: ${why}`);
            last = why;
          })
          .finally(() => {
            running = false;
          });
      };
      const timer = setInterval(check, ROUTE_CHECK_MS);
      timer.unref();
      return () => clearInterval(timer);
    });
  if (hub) background.add(() => agents.start());
  if (hub)
    background.add(() => {
      const off = keepAwake.follow(terminals);
      keepAwake.remote(config.remote.enabled);
      return () => {
        off();
        keepAwake.dispose();
      };
    });
  background.add(() => {
    if (hub && config.images.watchClipboard) clipboard.start();
    return () => clipboard.stop();
  });
  // macOS lets two processes hold the same keys, and both would open a selection: only the
  // production server starts the helper, never `bun run dev` beside it.
  const production = process.env.NODE_ENV === "production";
  background.add(() => {
    if (hub && production && process.platform === "darwin" && config.images.captureHotkey)
      hotkey.start();
    return () => hotkey.stop();
  });
  background.add(() => () => voice?.stop());
  // Unfinished recordings go on where they stopped; this is also the restart's resume.
  background.add(() => services.transcripts.watch());
  // A ready transcript gets its agent review (server/features/transcripts/review.ts).
  background.add(() =>
    services.transcripts.onReady((rec) => {
      // Also for a recording started before this server: its tile may not be there yet.
      placeInSistema(services.workspace, `rec:${rec.id}`);
      services.review
        .start(rec)
        .catch((err) => log("transcripts").error(`review ${rec.id} failed to start`, { err }));
    }),
  );
  // A recording's tile goes to the «Sistema» block, so a call recorded on its own shows there.
  background.add(() =>
    services.transcripts.onStart((rec) => placeInSistema(services.workspace, `rec:${rec.id}`)),
  );
  // An engine a crashed or restarted server left behind would hold the GPU unseen.
  background.add(() => {
    void ai?.reapLeftover().catch((err) => log("ai").error("leftover check failed", { err }));
    return () => ai?.stop("stopped with the server");
  });
  if (hub)
    background.add(() => {
      const ingest = () =>
        usage
          .run()
          .then((r) => {
            if (r.errors.length)
              log("usage").error(`${r.errors.length} files failed: ${r.errors[0]}`);
          })
          .catch((err) => log("usage").error(err.message))
          .then(() => samplePlans(db))
          .catch((err) => log("usage").error(`plan sample: ${err.message}`));
      void ingest();
      const timer = setInterval(ingest, USAGE_EVERY_MS);
      timer.unref();
      return () => clearInterval(timer);
    });
  // The effort judge's Monday pass: checked hourly, never at start, only where the config
  // turns it on.
  if (hub && config.usage.judgeAuto)
    background.add(() => {
      const check = () => {
        try {
          const run = services.judge.monday();
          if (run) log("usage").info(`effort judge: Monday pass ${run.id}`);
        } catch (err) {
          log("usage").error(`effort judge: ${errorMessage(err)}`);
        }
      };
      const timer = setInterval(check, JUDGE_CHECK_MS);
      timer.unref();
      return () => clearInterval(timer);
    });
  // The server's own log (the start script's redirect) and the PTY host's, both opened to
  // append, kept private (the shell creates the redirect 0644) and under LOG_MAX_BYTES with
  // one older file beside each.
  background.add(() => {
    const keepSmall = () => {
      for (const file of [
        join(DATA_DIR, "server.log"),
        hostPaths(DATA_DIR).log,
        aiPaths(DATA_DIR).log,
      ]) {
        const failed = makePrivate(file);
        if (failed) log("server").warn(`cannot make ${basename(file)} private`, { err: failed });
        if (rotate(file, LOG_MAX_BYTES)) log("server").info(`rotated ${basename(file)}`);
      }
    };
    keepSmall();
    const timer = setInterval(keepSmall, LOG_ROTATE_EVERY_MS);
    timer.unref();
    return () => clearInterval(timer);
  });
  return { ...services, clipboard: () => clipboard.state(), hotkey };
}
