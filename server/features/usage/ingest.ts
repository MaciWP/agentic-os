import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { errorMessage } from "../../error-message.ts";
import { jsonOrNull } from "../../json.ts";
import { keptSince, USAGE_KEEP_MS } from "../../retention.ts";
import { failed, traced } from "../../telemetry/span.ts";
import { ClaudeState, claudeLines } from "./claude.ts";
import { CodexState, codexLines } from "./codex.ts";
import { GrokUsage, grokLines, grokUsage } from "./grok.ts";
import type { Parsed } from "./parsed.ts";
import { claudeSources, codexSources, grokSources, type Source } from "./sources.ts";

// Reads the transcripts each harness keeps into agent_usage and agent_events (ADR 0008):
// Claude's sessions and subagents, Codex's rollouts and Grok's `grok usage`. Every row carries
// the harness's own id, so a file read twice, or read again after it shrank, never counts a
// call twice. Only counters and names are kept, never the text of a conversation.

// Small enough that one slice never holds the server up for long.
const CHUNK = 2 << 20;
export const USAGE_EVERY_MS = 5 * 60_000;

type Reader = { state: unknown; read: (lines: string[]) => Parsed; sessionId: () => string };

function readerFor(source: Source, saved: unknown): Reader {
  if (source.harness === "codex") {
    const state = CodexState.catch({
      sessionId: "",
      cwd: "",
      branch: "",
      model: "",
      records: false,
    }).parse(saved);
    return { state, read: (lines) => codexLines(lines, state), sessionId: () => state.sessionId };
  }
  const state = ClaudeState.catch({ cwd: "", branch: "" }).parse(saved);
  const file = { sessionId: source.sessionId, agent: source.agent ?? "" };
  return {
    state,
    read: (lines) => claudeLines(lines, file, state),
    sessionId: () => source.sessionId,
  };
}

// Ingest ------------------------------------------------------------------------------------

export type IngestDeps = {
  db: Database;
  home: string;
  // `grok usage <id>` as JSON (null: none recorded); null when Grok is not installed.
  grokUsage: ((sessionId: string) => Promise<unknown>) | null;
};

export type IngestRun = {
  startedAt: string;
  ms: number;
  files: number;
  read: number;
  bytes: number;
  errors: string[];
};

type SourceRow = { read_bytes: number; size: number; mtime: number; state: string | null };

export class UsageIngest {
  private running: Promise<IngestRun> | undefined;
  private readonly places = new Map<string, number>();
  last: IngestRun | undefined;

  constructor(private readonly deps: IngestDeps) {}

  // One run at a time; a caller during one gets that run.
  run(): Promise<IngestRun> {
    // A span of its own: under the request that asked for it, or a trace of its own when timed.
    this.running ??= traced("usage.ingest", "usage", {}, async (span) => {
      const run = await this.ingest();
      span.setAttributes({
        "usage.files": run.files,
        "usage.read": run.read,
        "usage.bytes": run.bytes,
      });
      if (run.errors.length) failed(span, `${run.errors.length} unreadable: ${run.errors[0]}`);
      return run;
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async ingest(): Promise<IngestRun> {
    const started = Date.now();
    const { home } = this.deps;
    const run: IngestRun = {
      startedAt: new Date(started).toISOString(),
      ms: 0,
      files: 0,
      read: 0,
      bytes: 0,
      errors: [],
    };
    const sources = [
      ...(await claudeSources(home)),
      ...(await codexSources(home)),
      ...(await grokSources(home)),
    ];
    run.files = sources.length;
    for (const source of sources) {
      try {
        const bytes = await this.readSource(source);
        if (bytes > 0) run.read++;
        run.bytes += bytes;
      } catch (err) {
        run.errors.push(`${source.path}: ${errorMessage(err)}`);
      }
      // Let requests through between files.
      await Bun.sleep(0);
    }
    await this.prune(sources);
    run.ms = Date.now() - started;
    this.last = run;
    return run;
  }

  // Calls and events older than USAGE_KEEP_MS leave, and the places none of the rest cites. A
  // file's offset stays while the file exists, so it is never read again into the rows just
  // pruned; a gone file's offset goes.
  private async prune(sources: Source[]): Promise<void> {
    const { db } = this.deps;
    const listed = new Set(sources.map((s) => s.path));
    const gone: string[] = [];
    for (const { path } of db.query<{ path: string }, []>("SELECT path FROM agent_sources").all())
      if (!listed.has(path) && !(await stat(path).catch(() => null))) gone.push(path);
    const since = keptSince(Date.now(), USAGE_KEEP_MS);
    const forget = db.query("DELETE FROM agent_sources WHERE path = ?");
    db.transaction(() => {
      db.run("DELETE FROM agent_usage WHERE at < ?", [since]);
      db.run("DELETE FROM agent_events WHERE at < ?", [since]);
      db.run("DELETE FROM agent_cost_checks WHERE start_time < ?", [since]);
      db.run("DELETE FROM plan_samples WHERE at < ?", [since]);
      db.run(
        `DELETE FROM agent_places WHERE id NOT IN (SELECT place_id FROM agent_usage)
           AND id NOT IN (SELECT place_id FROM agent_events)`,
      );
      for (const path of gone) forget.run(path);
    })();
    // A place written again gets a new id.
    this.places.clear();
  }

  // Reads what is new in one file; returns the bytes read.
  private async readSource(source: Source): Promise<number> {
    const { db } = this.deps;
    const s = await stat(source.path).catch(() => null);
    if (!s?.isFile()) return 0;
    const row = db
      .query<SourceRow, [string]>(
        "SELECT read_bytes, size, mtime, state FROM agent_sources WHERE path = ?",
      )
      .get(source.path);
    if (row && row.size === s.size && row.mtime === s.mtimeMs) return 0;
    // A file that shrank was rewritten: read it again; the ids keep the rows unique.
    const begin = row && row.read_bytes <= s.size ? row.read_bytes : 0;
    const reader = readerFor(source, begin > 0 && row?.state ? jsonOrNull(row.state) : null);
    const save = (pos: number) =>
      this.saveSource({ ...source, sessionId: reader.sessionId() }, pos, s, reader.state);
    if (source.harness === "grok") {
      const parsed = await this.readGrok(source, begin, s.size);
      this.write("grok", parsed, () => save(s.size));
      return s.size - begin;
    }
    let pos = begin;
    let chunk = CHUNK;
    while (pos < s.size) {
      const buf = new Uint8Array(
        await Bun.file(source.path)
          .slice(pos, pos + chunk)
          .arrayBuffer(),
      );
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) {
        // A line longer than the chunk, or a last line still being written.
        if (pos + buf.length >= s.size) break;
        chunk *= 2;
        continue;
      }
      chunk = CHUNK;
      const parsed = reader.read(new TextDecoder().decode(buf.subarray(0, end)).split("\n"));
      pos += end + 1;
      // The rows and how far they go are written together: a crash between them cannot lose
      // or repeat a line.
      this.write(source.harness, parsed, () => save(pos));
      await Bun.sleep(0);
    }
    // Only complete lines count as read; size and mtime mark the file as seen.
    save(pos);
    return pos - begin;
  }

  private async readGrok(source: Source, from: number, size: number): Promise<Parsed> {
    const cwd = source.cwd ?? "";
    const text = await Bun.file(source.path).slice(from, size).text();
    const parsed = grokLines(text.split("\n"), { sessionId: source.sessionId, cwd });
    const raw = this.deps.grokUsage ? await this.deps.grokUsage(source.sessionId) : null;
    if (raw !== null) {
      const report = GrokUsage.safeParse(raw);
      if (!report.success) throw new Error("grok usage: unexpected shape");
      parsed.usage = grokUsage(report.data, { cwd, at: new Date().toISOString() });
    }
    return parsed;
  }

  private place(cwd: string, branch: string): number {
    const key = `${cwd}\0${branch}`;
    const known = this.places.get(key);
    if (known !== undefined) return known;
    const { db } = this.deps;
    db.query("INSERT OR IGNORE INTO agent_places (cwd, branch) VALUES (?, ?)").run(cwd, branch);
    const id =
      db
        .query<{ id: number }, [string, string]>(
          "SELECT id FROM agent_places WHERE cwd = ? AND branch = ?",
        )
        .get(cwd, branch)?.id ?? 0;
    this.places.set(key, id);
    return id;
  }

  private write(harness: string, parsed: Parsed, after: () => void): void {
    const { db } = this.deps;
    const usage = db.query(
      `INSERT OR REPLACE INTO agent_usage (harness, id, session_id, place_id, agent, skill, model,
         at, input, cache_read, cache_write, cache_write_1h, output, role, effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const event = db.query(
      `INSERT OR REPLACE INTO agent_events (harness, id, kind, session_id, place_id, agent, name,
         detail, ms, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const drop = db.query("DELETE FROM agent_usage WHERE harness = ? AND id = ?");
    const check = db.query(
      `INSERT OR REPLACE INTO agent_cost_checks (harness, session_id, start_time, total_usd, models)
       VALUES (?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (const id of parsed.drop) drop.run(harness, id);
      for (const u of parsed.usage)
        usage.run(
          harness,
          u.id,
          u.sessionId,
          this.place(u.cwd, u.branch),
          u.agent,
          u.skill,
          u.model,
          u.at,
          u.input,
          u.cacheRead,
          u.cacheWrite,
          u.cacheWrite1h,
          u.output,
          u.role ?? "call",
          u.effort ?? "",
        );
      for (const e of parsed.events)
        event.run(
          harness,
          e.id,
          e.kind,
          e.sessionId,
          this.place(e.cwd, e.branch),
          e.agent,
          e.name,
          e.detail,
          e.ms,
          e.at,
        );
      // In file order: the last count read is the one kept.
      for (const c of parsed.checks)
        check.run(harness, c.sessionId, c.startTime, c.totalUsd, JSON.stringify(c.models));
      after();
    })();
  }

  private saveSource(
    source: Source,
    readBytes: number,
    file: { size: number; mtimeMs: number },
    state: unknown,
  ): void {
    this.deps.db
      .query(
        `INSERT OR REPLACE INTO agent_sources (path, harness, session_id, read_bytes, size, mtime, state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.path,
        source.harness,
        source.sessionId,
        readBytes,
        file.size,
        file.mtimeMs,
        JSON.stringify(state),
      );
  }
}
