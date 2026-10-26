import type { Database } from "bun:sqlite";
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import {
  type AgentInfo,
  Listeners,
  type TerminalInfo,
  type Terminals,
} from "../terminals/contract.ts";
import { decorated } from "../terminals/decorated.ts";
import {
  AGENTS,
  claudeSession,
  codexRollouts,
  codexState,
  grokSessions,
  lsofOpenFiles,
  type OpenFiles,
  type Rollout,
} from "./discovery.ts";
import { claudeDoing, claudeTranscript, codexDoing, type Doing } from "./doing.ts";

// Each agent terminal's session id and state, read from the files its harness keeps (ADR
// 0008): Claude's `~/.claude/sessions/<pid>.json`, Grok's active sessions and the rollout
// a Codex process holds open. Nothing is injected into the launch. The server reads them, so the PTY host and
// its protocol stay as they are.

// Codex writes no file the app can watch for its sessions, so its rollout is read this often
// while a Codex terminal runs.
export const CODEX_EVERY_MS = 2000;
const DEBOUNCE_MS = 150;

const same = (a: AgentInfo | undefined, b: AgentInfo) =>
  a?.sessionId === b.sessionId &&
  a?.state === b.state &&
  a?.asks === b.asks &&
  a?.title === b.title &&
  a?.prompt === b.prompt &&
  a?.lastMessage === b.lastMessage &&
  a?.question === b.question;

// What the agent works on, and a turn that ended on a decision as a question. Only a waiting
// agent asks: a working one's last message belongs to its previous turn. The question's text
// goes only with the question its harness says it waits on.
const asked = (info: AgentInfo, { decides, question, ...doing }: Doing): AgentInfo => ({
  ...info,
  ...doing,
  ...(question && info.asks === "question" && { question }),
  ...(decides && info.state === "needs_you" && !info.asks && { asks: "question" as const }),
});

export type TrackerDeps = {
  home: string;
  db: Database;
  openFiles?: OpenFiles;
  // A terminal started a new agent session (objectives/store.ts files it under its objective).
  onSession?: (t: TerminalInfo, sessionId: string) => void;
};

export class AgentTracker {
  private readonly info = new Map<string, AgentInfo>();
  // The rollout each Codex terminal writes, last seen open.
  private readonly rollouts = new Map<string, Rollout>();
  // What each terminal's transcript said at the size it had, so an unchanged one is not read
  // again.
  private readonly doing = new Map<string, { path: string; size: number; doing: Doing }>();
  private readonly listeners = new Listeners();
  private terminals: TerminalInfo[] = [];
  private busy = false;
  private wantList = false;
  private wantRead = false;

  constructor(
    private readonly inner: Pick<Terminals, "list" | "subscribe">,
    private readonly deps: TrackerDeps,
  ) {}

  // Called when an agent's session or state changed.
  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  decorate(t: TerminalInfo): TerminalInfo {
    return { ...t, agent: AGENTS.has(t.harness) ? (this.info.get(t.id) ?? null) : null };
  }

  // Reads the list on every host change, Claude's records when its directory changes, and a
  // Codex rollout while one runs. Returns the stop.
  start(): () => void {
    const off = this.inner.subscribe(() => this.kick(true));
    this.kick(true);
    let watcher: FSWatcher | undefined;
    let timer: Timer | undefined;
    try {
      watcher = watch(join(this.deps.home, ".claude", "sessions"), () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.kick(false), DEBOUNCE_MS);
      });
      watcher.on("error", () => watcher?.close());
    } catch {
      // No Claude on this machine: its terminals keep a null state.
    }
    const codex = setInterval(() => {
      if (this.terminals.some((t) => t.harness === "codex" && t.state === "running"))
        this.kick(false);
    }, CODEX_EVERY_MS);
    codex.unref();
    return () => {
      off();
      watcher?.close();
      clearTimeout(timer);
      clearInterval(codex);
    };
  }

  // One update at a time; a request during one runs once it ends. `list` reads the terminals
  // from the host first.
  kick(list: boolean): Promise<void> {
    if (list) this.wantList = true;
    else this.wantRead = true;
    if (this.busy) return Promise.resolve();
    this.busy = true;
    return (async () => {
      try {
        while (this.wantList || this.wantRead) {
          const fetch = this.wantList;
          this.wantList = false;
          this.wantRead = false;
          if (fetch) this.terminals = await this.inner.list();
          await this.update(this.terminals);
        }
      } catch (err) {
        log("agent state").error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    })();
  }

  private async update(list: TerminalInfo[]): Promise<void> {
    const { home } = this.deps;
    const running = (h: string) => list.filter((t) => t.harness === h && t.state === "running");
    const grok = running("grok").length > 0 ? await grokSessions(home) : new Map();
    const codexPids = running("codex").flatMap((t) => (t.pid === null ? [] : [t.pid]));
    const held = await (this.deps.openFiles ?? lsofOpenFiles)(codexPids);
    let changed = false;
    for (const t of list) {
      if (!AGENTS.has(t.harness)) continue;
      const prev = this.info.get(t.id);
      // An ended agent still says what it worked on.
      const kept: AgentInfo = {
        sessionId: prev?.sessionId ?? null,
        state: null,
        ...(prev?.title && { title: prev.title }),
        ...(prev?.prompt && { prompt: prev.prompt }),
        ...(prev?.lastMessage && { lastMessage: prev.lastMessage }),
      };
      let next: AgentInfo = kept;
      if (t.state === "running" && t.pid !== null) {
        if (t.harness === "claude") {
          const session = await claudeSession(home, t.pid, Date.parse(t.startedAt));
          if (session?.sessionId) {
            // Found once per session; /clear starts another.
            const known = this.doing.get(t.id)?.path;
            const path = known?.endsWith(`/${session.sessionId}.jsonl`)
              ? known
              : await claudeTranscript(home, session.sessionId);
            next = asked(session, path ? await this.read(t.id, path, claudeDoing) : {});
          } else next = session ?? kept;
        } else if (t.harness === "grok") next = { ...kept, sessionId: grok.get(t.pid) ?? null };
        else {
          const rollout = this.codexRollout(t.id, held.get(t.pid) ?? []);
          if (rollout)
            next = asked(
              { sessionId: rollout.id, state: await codexState(rollout.path) },
              await this.read(t.id, rollout.path, codexDoing),
            );
        }
      }
      if (same(prev, next)) continue;
      this.info.set(t.id, next);
      changed = true;
      if (next.sessionId !== null && next.sessionId !== prev?.sessionId) {
        this.deps.db
          .query("UPDATE terminal_sessions SET session_id = ? WHERE id = ?")
          .run(next.sessionId, t.id);
        this.deps.onSession?.(t, next.sessionId);
      }
    }
    const ids = new Set(list.map((t) => t.id));
    for (const id of [...this.info.keys()]) {
      if (ids.has(id)) continue;
      this.info.delete(id);
      this.rollouts.delete(id);
      this.doing.delete(id);
    }
    if (changed) this.listeners.notify();
  }

  // What a transcript says, read again only when it grew.
  private async read(
    id: string,
    path: string,
    from: (path: string) => Promise<Doing>,
  ): Promise<Doing> {
    const size = Bun.file(path).size;
    const known = this.doing.get(id);
    if (known?.path === path && known.size === size) return known.doing;
    const doing = await from(path);
    this.doing.set(id, { path, size, doing });
    return doing;
  }

  // A Codex terminal's rollout is the one its process holds open: Codex creates it on the
  // first message, appends to the old one on a resume and switches on /resume or /new. When
  // nothing is open the last one seen stays.
  // ponytail: with several open (sub-agents), the known one or else the oldest wins; read
  // their session_meta if a sub-agent's ever does.
  private codexRollout(id: string, files: string[]): Rollout | undefined {
    const open = codexRollouts(this.deps.home, files);
    const known = this.rollouts.get(id);
    const next = open.find((r) => r.path === known?.path) ?? open[0] ?? known;
    if (next) this.rollouts.set(id, next);
    return next;
  }
}

// The terminals with each agent's session and state.
export const withAgents = (inner: Terminals, tracker: AgentTracker): Terminals =>
  decorated(
    inner,
    (t) => tracker.decorate(t),
    (listener) => tracker.subscribe(listener),
  );
