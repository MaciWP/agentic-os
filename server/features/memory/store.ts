import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BarButton, barOf } from "../../../shared/work-bar.ts";
import { fileVersion, saveRecovery } from "../../recovery.ts";
import {
  describeDoc,
  type Entry,
  MAX_DOC_BYTES,
  type Source,
  type SourceId,
  walkSource,
} from "./sources.ts";

// The index over every source: rebuilt from the files by mtime and size, never trusted
// over them. An id is servable only if the last walk listed it.

export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type DocSummary = {
  id: string;
  source: SourceId;
  rel: string;
  title: string;
  description: string | null;
  mtime: number;
};
export type Doc = DocSummary & { writable: boolean; body: string };
export type Hit = DocSummary & { snippet: string };
export type SourceInfo = {
  id: SourceId;
  label: string;
  writable: boolean;
  count: number;
  missing: boolean;
};

type Row = { rowid: number; id: string; mtime: number; size: number };
type DocRow = DocSummary & { path: string; follow: number };

// Snippet marks: control characters that cannot appear in the Markdown the UI escapes.
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";
const MAX_TERMS = 12;
const MAX_HITS = 50;
// Share of the query's weight a hit must hold (Elasticsearch's minimum_should_match). Set once
// from first principles, never tuned.
const MIN_SHARE = 0.5;

// User text to FTS5 terms: every distinct word as a quoted prefix term. Quoting leaves no
// operator or column syntax for the user to break.
function terms(q: string): string[] {
  const words = q.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_TERMS).map((t) => `"${t}"*`);
}

// Index files (MEMORY.md) only repeat the topic files' descriptions, and Grok's inbox and
// archive hold drafts it has not reviewed: listing shows them, search leaves them out.
function searchable(d: { source: string; rel: string }): boolean {
  if (/(^|\/)MEMORY\.md$/.test(d.rel)) return false;
  return !(d.source === "grok" && /(^|\/)(_inbox|archive)\//.test(d.rel));
}

export class MemoryStore {
  private inflight: Promise<void> | null = null;
  private missing = new Set<SourceId>();

  constructor(
    private readonly db: Database,
    readonly sources: Source[],
    // Parent of the writable sources' folders: data/notes, data/memory, data/prompts.
    private readonly dataDir: string,
  ) {}

  source(id: string): Source | undefined {
    return this.sources.find((s) => s.id === id);
  }

  // One walk at a time: concurrent callers share it, so two never index the same change.
  refresh(): Promise<void> {
    this.inflight ??= this.walk().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  // After an app write: a walk that started before the write may have missed it.
  async refreshAfterWrite(): Promise<void> {
    await this.inflight?.catch(() => {});
    await this.refresh();
  }

  private async walk(): Promise<void> {
    const walked = await Promise.all(this.sources.map(walkSource));
    this.missing = new Set(this.sources.filter((_, i) => !walked[i]?.found).map((s) => s.id));
    const found = walked.flatMap((w) => w.entries);
    const rows = this.db.query<Row, []>("SELECT rowid, id, mtime, size FROM memory_docs").all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const changed = found.filter((e) => {
      const r = byId.get(e.id);
      return !r || r.mtime !== e.mtime || r.size !== e.size;
    });
    const texts = await Promise.all(changed.map((e) => readDoc(e)));
    const seen = new Set(found.map((e) => e.id));
    const db = this.db;
    db.transaction(() => {
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        db.query("DELETE FROM memory_docs WHERE rowid = ?").run(r.rowid);
        db.query("DELETE FROM memory_fts WHERE rowid = ?").run(r.rowid);
      }
      changed.forEach((e, i) => {
        const text = texts[i];
        if (text == null) return;
        const { title, description } = describeDoc(text, e.rel);
        const values = [
          e.source,
          e.rel,
          e.path,
          e.follow ? 1 : 0,
          title,
          description,
          e.mtime,
          e.size,
        ];
        const old = byId.get(e.id);
        let rowid: number;
        if (old) {
          rowid = old.rowid;
          db.query(
            "UPDATE memory_docs SET source = ?, rel = ?, path = ?, follow = ?, title = ?, description = ?, mtime = ?, size = ? WHERE rowid = ?",
          ).run(...values, rowid);
          db.query("DELETE FROM memory_fts WHERE rowid = ?").run(rowid);
        } else {
          rowid = Number(
            db
              .query(
                "INSERT INTO memory_docs (id, source, rel, path, follow, title, description, mtime, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(e.id, ...values).lastInsertRowid,
          );
        }
        db.query("INSERT INTO memory_fts (rowid, title, body) VALUES (?, ?, ?)").run(
          rowid,
          title,
          text,
        );
      });
    })();
  }

  async listSources(): Promise<SourceInfo[]> {
    await this.refresh();
    const counts = new Map(
      this.db
        .query<{ source: string; n: number }, []>(
          "SELECT source, COUNT(*) AS n FROM memory_docs GROUP BY source",
        )
        .all()
        .map((r) => [r.source, r.n]),
    );
    return this.sources.map((s) => ({
      id: s.id,
      label: s.label,
      writable: s.writable,
      count: counts.get(s.id) ?? 0,
      missing: this.missing.has(s.id),
    }));
  }

  async list(source: SourceId): Promise<DocSummary[]> {
    await this.refresh();
    return this.db
      .query<DocSummary, [string]>(
        "SELECT id, source, rel, title, description, mtime FROM memory_docs WHERE source = ? ORDER BY mtime DESC",
      )
      .all(source);
  }

  // The work bar: saved prompts marked `bar: true`, by their order and then their title, each
  // with its description for the button's tooltip.
  // ponytail: reads every saved prompt on each call, fine for dozens; index bar/label/order in
  // memory_docs when the folder holds hundreds.
  async bar(): Promise<BarButton[]> {
    const docs = await this.list("prompts");
    const read = await Promise.all(docs.map((d) => this.get(d.id).catch(() => null)));
    return read
      .flatMap((d, i) => {
        const meta = d && barOf(d.body);
        const description = docs[i]?.description ?? undefined;
        return d && meta?.bar
          ? [{ id: d.id, title: d.title, label: meta.label, order: meta.order, description }]
          : [];
      })
      .sort(
        (a, b) =>
          (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
          a.title.localeCompare(b.title),
      );
  }

  // Any word may match, but a hit must hold MIN_SHARE of the query's weight, each word weighted
  // by its rarity as BM25 weighs it: a query about nothing in the notes returns nothing rather
  // than whatever shares one common word. Hits holding every word come first, then BM25 order.
  async search(q: string): Promise<Hit[]> {
    const words = terms(q);
    if (!words.length) return [];
    await this.refresh();
    const docs =
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_docs").get()?.n ?? 0;
    const held = new Map<number, number>();
    let total = 0;
    for (const w of words) {
      const rows = this.db
        .query<{ rowid: number }, [string]>("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
        .all(w);
      const idf = Math.log((docs - rows.length + 0.5) / (rows.length + 0.5) + 1);
      total += idf;
      for (const r of rows) held.set(r.rowid, (held.get(r.rowid) ?? 0) + idf);
    }
    const share = (rowid: number) => (held.get(rowid) ?? 0) / total;
    const all = (rowid: number) => (share(rowid) > 1 - 1e-9 ? 1 : 0);
    return this.hits(words.join(" OR "))
      .filter((h) => share(h.rowid) >= MIN_SHARE - 1e-9)
      .sort((a, b) => all(b.rowid) - all(a.rowid))
      .slice(0, MAX_HITS)
      .map(({ rowid: _r, ...hit }) => hit);
  }

  // Docs naming an exact phrase, such as a ticket key: its words adjacent, in order, the last
  // one whole. As free words, ABC-30 would also find a note naming ABC and 2026-09-30.
  async phrase(q: string): Promise<Hit[]> {
    const words = q.normalize("NFC").match(/[\p{L}\p{N}]+/gu);
    if (!words) return [];
    await this.refresh();
    return this.hits(`"${words.join(" ")}"`)
      .slice(0, MAX_HITS)
      .map(({ rowid: _r, ...hit }) => hit);
  }

  private hits(match: string): (Hit & { rowid: number })[] {
    return this.db
      .query<Hit & { rowid: number }, [string, string, string]>(
        `SELECT d.rowid, d.id, d.source, d.rel, d.title, d.description, d.mtime,
                snippet(memory_fts, 1, ?, ?, '…', 14) AS snippet
         FROM memory_fts JOIN memory_docs d ON d.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts, 5.0, 1.0)`,
      )
      .all(MARK_START, MARK_END, match)
      .filter(searchable);
  }

  // The index row for an id, after a walk; never a path built from the id.
  async row(id: string): Promise<DocRow | null> {
    await this.refresh();
    return (
      this.db
        .query<DocRow, [string]>(
          "SELECT id, source, rel, title, description, mtime, path, follow FROM memory_docs WHERE id = ?",
        )
        .get(id) ?? null
    );
  }

  async get(id: string): Promise<Doc> {
    const row = await this.row(id);
    if (!row) throw new MemoryError(404, "not_found", "no such document");
    const s = await (row.follow ? stat : lstat)(row.path).catch(() => null);
    if (!s?.isFile() || s.size > MAX_DOC_BYTES)
      throw new MemoryError(404, "not_found", "the document is gone");
    const bytes = await Bun.file(row.path).bytes();
    // The file can grow between stat and read: the limit holds on what was actually read.
    if (bytes.length > MAX_DOC_BYTES)
      throw new MemoryError(404, "not_found", "the document is gone");
    const { path: _p, follow: _f, ...summary } = row;
    return {
      ...summary,
      // The file's own mtime: what a save must match, whatever the index holds.
      mtime: s.mtimeMs,
      writable: this.source(row.source)?.writable ?? false,
      body: new TextDecoder().decode(bytes),
    };
  }

  async create(sourceId: string, name: string, body: string): Promise<Doc> {
    const source = this.source(sourceId);
    if (!source) throw new MemoryError(404, "not_found", "no such source");
    const dir = await writableDir(this.dataDir, source);
    const file = fileName(name);
    checkSize(body);
    // wx = O_CREAT|O_EXCL: fails on an existing file and on any symlink, dangling or not.
    await writeFile(join(dir, file), body, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST")
        throw new MemoryError(409, "exists", "a document with that name exists");
      throw err;
    });
    await this.refreshAfterWrite();
    return this.get(`${source.id}:${file}`);
  }

  // One write at a time per document, so two saves made against the same mtime cannot
  // both pass the stale check: the second one sees the first one's mtime and gets 409.
  private locks = new Map<string, Promise<unknown>>();
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      });
    return next;
  }

  update(id: string, body: string, mtime: number): Promise<Doc> {
    return this.serial(id, () => this.write(id, body, mtime));
  }

  remove(id: string, mtime?: number, version?: string): Promise<string> {
    return this.serial(id, () => this.unlinkDoc(id, mtime, version));
  }

  private async write(id: string, body: string, mtime: number): Promise<Doc> {
    const { row, dir } = await this.writableRow(id);
    checkSize(body);
    const s = await lstat(row.path);
    if (s.mtimeMs !== mtime)
      throw new MemoryError(409, "stale", "the document changed since you opened it");
    // Same folder, then rename: a reader sees the old or the new text, never half.
    const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, body, { flag: "wx" });
      await rename(tmp, row.path);
    } finally {
      await rm(tmp, { force: true });
    }
    await this.refreshAfterWrite();
    return this.get(id);
  }

  private async unlinkDoc(id: string, mtime?: number, version?: string): Promise<string> {
    const { row } = await this.writableRow(id);
    const before = await lstat(row.path);
    if (mtime === undefined || before.mtimeMs !== mtime)
      throw new MemoryError(409, "stale", "the document changed since you opened it");
    const snapshot = await fileVersion(row.path);
    if (snapshot.version !== version)
      throw new MemoryError(409, "stale", "the document content changed since you opened it");
    const recovery = await saveRecovery(this.dataDir, row.path, "note-delete", snapshot.bytes);
    if (
      (await fileVersion(row.path)).version !== snapshot.version ||
      (await lstat(row.path)).mtimeMs !== mtime
    )
      throw new MemoryError(409, "stale", "the document changed during backup");
    await unlink(row.path);
    await this.refreshAfterWrite();
    return recovery;
  }

  // An indexed doc of a writable source whose file is still a regular file in its folder.
  private async writableRow(id: string): Promise<{ row: DocRow; dir: string }> {
    const row = await this.row(id);
    if (!row) throw new MemoryError(404, "not_found", "no such document");
    const source = this.source(row.source);
    if (!source?.writable) throw new MemoryError(403, "read_only", "this source is read-only");
    const dir = await writableDir(this.dataDir, source);
    const s = await lstat(row.path).catch(() => null);
    if (!s?.isFile() || row.path !== join(dir, row.rel))
      throw new MemoryError(404, "not_found", "the document is gone");
    return { row, dir };
  }
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u;

// A note name to its file: one path segment, no leading dot, always ending in .md.
export function fileName(name: string): string {
  const base = name.normalize("NFC").trim().replace(/\.md$/i, "");
  if (!NAME.test(base))
    throw new MemoryError(400, "bad_name", "use letters, digits, spaces, _ . -");
  return `${base}.md`;
}

function checkSize(body: string) {
  if (Buffer.byteLength(body) > MAX_DOC_BYTES)
    throw new MemoryError(413, "too_large", "documents are limited to 1 MB");
}

// A writable source's folder: created if absent, then it must be a real directory that
// resolves to exactly <dataDir>/<source>. A symlinked folder would move writes elsewhere.
async function writableDir(dataDir: string, source: Source): Promise<string> {
  if (!source.writable) throw new MemoryError(403, "read_only", "this source is read-only");
  const dir = join(dataDir, source.id);
  await mkdir(dir, { recursive: true });
  const s = await lstat(dir);
  const [real, base] = await Promise.all([realpath(dir), realpath(dataDir)]);
  if (!s.isDirectory() || real !== join(base, source.id))
    throw new MemoryError(403, "unsafe_dir", "the source folder is not a plain directory");
  return dir;
}

async function readDoc(e: Entry): Promise<string | null> {
  try {
    return await Bun.file(e.path).text();
  } catch {
    return null;
  }
}
