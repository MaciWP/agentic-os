import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { variablesIn } from "../../../shared/work-bar.ts";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { contentVersion } from "../../recovery.ts";
import { cleanEnv } from "../terminals/env.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { seedMiner } from "./miner-prompt.ts";
import { describeDoc, memorySources, type SourceRoots, walkSource } from "./sources.ts";
import { type Doc, type DocSummary, type Hit, MARK_END, MARK_START, MemoryStore } from "./store.ts";

// A fake home with every harness layout, and a data dir for the app's own sources.
let dir: string;
let roots: SourceRoots;
const home = () => roots.home;

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-memory-")));
  roots = { home: join(dir, "home"), dataDir: join(dir, "data"), repos: [] };
  const claude = join(home(), ".claude");
  put(
    join(claude, "projects", "proj-a", "memory", "plan.md"),
    "---\nname: Plan de migración\ndescription: pasos de la migración\nmetadata:\n  name: nested\n---\nCuerpo con migración de datos.\n",
  );
  put(join(claude, "projects", "proj-a", "memory", "deep", "note.md"), "# Nested heading\nbody\n");
  put(join(claude, "projects", "proj-a", "memory", "auth.json"), '{"secret": true}');
  put(join(claude, "projects", "proj-a", "memory", ".hidden.md"), "hidden");
  put(join(dir, "elsewhere", "leak.md"), "leaked text zebra");
  symlinkSync(
    join(dir, "elsewhere", "leak.md"),
    join(claude, "projects", "proj-a", "memory", "link.md"),
  );
  symlinkSync(join(dir, "elsewhere"), join(claude, "projects", "proj-a", "memory", "linkdir"));
  put(join(dir, "real-claude.md"), "# Global rules\n");
  symlinkSync(join(dir, "real-claude.md"), join(claude, "CLAUDE.md"));
  put(join(home(), ".codex", "AGENTS.md"), "# Codex agents\n");
  put(join(home(), ".grok", "memory-v2", "global", "MEMORY.md"), "grok memory text\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const store = () => new MemoryStore(openDb(":memory:"), memorySources(roots), roots.dataDir);

describe("sources", () => {
  test("walks markdown only: no dotfiles, no symlinks, nested trees kept", async () => {
    const [, , , claudeMemory] = memorySources(roots);
    const { entries } = await walkSource(claudeMemory as never);
    expect(entries.map((e) => e.id).sort()).toEqual([
      "claude-memory:proj-a/deep/note.md",
      "claude-memory:proj-a/plan.md",
    ]);
  });

  test("a named single file is followed through its symlink", async () => {
    const claudeMd = memorySources(roots).find((s) => s.id === "claude-md");
    const { entries } = await walkSource(claudeMd as never);
    expect(entries.map((e) => [e.id, e.follow])).toEqual([["claude-md:global/CLAUDE.md", true]]);
  });

  test("titles come from top-level frontmatter, then the first heading, then the name", () => {
    expect(describeDoc("---\nmetadata:\n  name: nested\n---\n# Heading\n", "a/b.md")).toEqual({
      title: "Heading",
      description: null,
    });
    expect(describeDoc("---\nname: 'Quoted'\ndescription: d\n---\n", "x.md")).toEqual({
      title: "Quoted",
      description: "d",
    });
    expect(describeDoc("plain text", "dir/file-name.md").title).toBe("file-name");
  });
});

describe("index and search", () => {
  test("search without accents finds accented text, with marked snippets", async () => {
    const hits = await store().search("migracion");
    expect(hits[0]?.id).toBe("claude-memory:proj-a/plan.md");
    expect(hits[0]?.title).toBe("Plan de migración");
    expect(hits[0]?.snippet).toContain(`${MARK_START}migración${MARK_END}`);
  });

  test("empty or operator-only queries return nothing, never an FTS syntax error", async () => {
    const s = store();
    for (const q of ["", "   ", '"', "AND OR NOT", "*", "body:(", "-"])
      expect(Array.isArray(await s.search(q))).toBe(true);
    expect(await s.search("")).toEqual([]);
  });

  test("symlinked files never reach the index", async () => {
    expect(await store().search("zebra")).toEqual([]);
  });

  test("concurrent refreshes after a change leave one row per id", async () => {
    const db = openDb(":memory:");
    const s = new MemoryStore(db, memorySources(roots), roots.dataDir);
    await s.refresh();
    const file = join(home(), ".grok", "memory-v2", "global", "MEMORY.md");
    writeFileSync(file, "grok memory text changed\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    const docs = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_docs").get()?.n;
    const fts = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_fts").get()?.n;
    const ids = db
      .query<{ n: number }, []>("SELECT COUNT(DISTINCT id) AS n FROM memory_docs")
      .get()?.n;
    expect(docs).toBe(fts);
    expect(docs).toBe(ids);
    const fresh = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'changed'",
      )
      .get()?.n;
    expect(fresh).toBe(1);
  });

  test("any word may match, if the hit holds half the query's weight", async () => {
    const s = store();
    const ids = (hits: Hit[]) => hits.map((h) => h.id).sort();
    // Each word is in one doc: each doc holds half the weight.
    expect(ids(await s.search("migracion heading"))).toEqual([
      "claude-memory:proj-a/deep/note.md",
      "claude-memory:proj-a/plan.md",
    ]);
    // A word in no doc is the rarest, so the one doc matching the other word holds too little.
    expect(await s.search("migracion quokkaz")).toEqual([]);
  });

  test("a phrase finds its words adjacent and whole, as a ticket key is written", async () => {
    const s = store();
    const near = join(home(), ".codex", "memories", "near.md");
    const named = join(home(), ".codex", "memories", "named.md");
    put(near, "ABC-300 closed on 2026-09-30\n");
    put(named, "ABC-30 fixed\n");
    try {
      expect((await s.phrase("ABC-30")).map((h) => h.id)).toEqual(["codex:memories/named.md"]);
      expect(await s.phrase("--")).toEqual([]);
    } finally {
      rmSync(near);
      rmSync(named);
    }
  });

  test("search leaves out index files and Grok drafts; listing keeps them", async () => {
    const s = store();
    const draft = join(home(), ".grok", "memory-v2", "global", "_inbox", "draft.md");
    put(draft, "draft numbat\n");
    try {
      expect(await s.search("grok")).toEqual([]);
      expect(await s.search("numbat")).toEqual([]);
      expect((await s.list("grok")).map((d) => d.rel).sort()).toEqual([
        "memory-v2/global/MEMORY.md",
        "memory-v2/global/_inbox/draft.md",
      ]);
    } finally {
      rmSync(draft);
    }
  });

  test("a deleted file leaves the index", async () => {
    const s = store();
    const file = join(home(), ".codex", "memories", "gone.md");
    put(file, "ephemeral walrus\n");
    expect((await s.search("walrus")).length).toBe(1);
    rmSync(file);
    expect(await s.search("walrus")).toEqual([]);
  });

  test("sources report counts and the ones missing on disk", async () => {
    const list = await store().listSources();
    const by = Object.fromEntries(list.map((x) => [x.id, x]));
    expect(by["claude-memory"]).toMatchObject({ count: 2, writable: false, missing: false });
    expect(by.notes).toMatchObject({ writable: true });
    expect(by.grok?.missing).toBe(false);
  });
});

type Reply = {
  error: string;
  doc: Doc;
  docs: DocSummary[];
  hits: Hit[];
};

describe("routes", () => {
  const make = () => {
    const config = ConfigSchema.parse({ port: 4317, terminals: { shell: "/bin/sh" } });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () =>
      Promise.resolve(cleanEnv({ PATH: "/bin" }, {})),
    );
    return createApp({ config, db, terminals, tokens: new AttachTokens(), memoryRoots: roots });
  };
  // Built lazily: roots only exist after beforeAll, and a missing root would mean the real home.
  let built: ReturnType<typeof make> | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    built ??= make();
    const res = await built.request(`/api/memory${path}`, {
      method,
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Reply };
  };
  const harnessFiles = () =>
    readdirSync(home(), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const p = join(d.parentPath, d.name);
        return `${p}:${statSync(p).mtimeMs}`;
      })
      .sort();

  test("ids resolve only through the index", async () => {
    for (const id of [
      "claude-memory:proj-a/../../../real-claude.md",
      "claude-memory:proj-a/auth.json",
      "claude-memory:proj-a/link.md",
      "nope:plan.md",
      "",
    ])
      expect((await call("GET", `/doc?id=${encodeURIComponent(id)}`)).status).toBe(404);
    const ok = await call("GET", `/doc?id=${encodeURIComponent("claude-memory:proj-a/plan.md")}`);
    expect(ok.status).toBe(200);
    expect(ok.json.doc).toMatchObject({ writable: false, title: "Plan de migración" });
    expect("path" in ok.json.doc).toBe(false);
    expect((await call("GET", "/docs?source=unknown")).status).toBe(404);
  });

  test("notes CRUD: create, read, stale save, save, delete; no harness file changes", async () => {
    const before = harnessFiles();
    const created = await call("POST", "/doc", {
      source: "notes",
      name: "Ideas B3",
      body: "# Ideas\nuno\n",
    });
    expect(created.status).toBe(201);
    const doc = created.json.doc;
    expect(doc).toMatchObject({ id: "notes:Ideas B3.md", title: "Ideas", writable: true });
    expect((await call("GET", "/docs?source=notes")).json.docs.map((d) => d.id)).toEqual([
      "notes:Ideas B3.md",
    ]);
    expect(
      (await call("POST", "/doc", { source: "notes", name: "Ideas B3.md", body: "x" })).status,
    ).toBe(409);
    const stale = await call("PUT", "/doc", {
      id: doc.id,
      body: "# Ideas\ndos\n",
      mtime: doc.mtime - 1,
    });
    expect(stale).toMatchObject({ status: 409, json: { error: "stale" } });
    const saved = await call("PUT", "/doc", {
      id: doc.id,
      body: "# Ideas\ndos\n",
      mtime: doc.mtime,
    });
    expect(saved.status).toBe(200);
    expect(saved.json.doc.body).toBe("# Ideas\ndos\n");
    expect(typeof saved.json.doc.mtime).toBe("number");
    expect((await call("GET", "/search?q=dos")).json.hits[0]?.id).toBe(doc.id);
    expect(readdirSync(join(roots.dataDir, "notes"))).toEqual(["Ideas B3.md"]);
    expect(
      (
        await call("DELETE", "/doc", {
          id: doc.id,
          mtime: saved.json.doc.mtime,
          version: contentVersion(saved.json.doc.body),
        })
      ).status,
    ).toBe(200);
    expect((await call("GET", `/doc?id=${encodeURIComponent(doc.id)}`)).status).toBe(404);
    expect((await call("GET", "/search?q=dos")).json.hits).toEqual([]);
    expect(harnessFiles()).toEqual(before);
  });

  test("two saves against the same version: one wins, the other is stale", async () => {
    const created = await call("POST", "/doc", { source: "notes", name: "Carrera", body: "a\n" });
    const { id, mtime } = created.json.doc;
    try {
      const results = await Promise.all(
        ["uno\n", "dos\n"].map((body) => call("PUT", "/doc", { id, body, mtime })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)?.json.doc.body;
      expect(winner).toBeDefined();
      expect((await call("GET", `/doc?id=${encodeURIComponent(id)}`)).json.doc.body).toBe(
        winner as string,
      );
    } finally {
      await call("DELETE", "/doc", { id, mtime, version: "0".repeat(64) });
    }
  });

  test("harness documents cannot be written through any endpoint", async () => {
    const id = "claude-memory:proj-a/plan.md";
    const { mtime } = (await call("GET", `/doc?id=${encodeURIComponent(id)}`)).json.doc;
    expect((await call("PUT", "/doc", { id, body: "x", mtime })).json.error).toBe("read_only");
    expect((await call("DELETE", "/doc", { id, mtime, version: "0".repeat(64) })).json.error).toBe(
      "read_only",
    );
    expect(
      (await call("POST", "/doc", { source: "claude-memory", name: "x", body: "x" })).status,
    ).toBe(403);
    expect((await call("POST", "/doc", { source: "grok", name: "x", body: "x" })).status).toBe(403);
    expect((await call("POST", "/doc", { source: "nope", name: "x", body: "x" })).status).toBe(404);
    expect(
      readFileSync(join(home(), ".claude", "projects", "proj-a", "memory", "plan.md"), "utf8"),
    ).toContain("Cuerpo con migración");
  });

  test("names stay one plain path segment", async () => {
    for (const name of ["a/b", "../x", ".env", "", "x\u0000y", "a\\b", "-".repeat(90)]) {
      const res = await call("POST", "/doc", { source: "memory", name, body: "x" });
      expect(res).toMatchObject({ status: 400 });
    }
  });

  test("documents over 1 MB are refused with 413", async () => {
    const big = "é".repeat(600_000);
    expect((await call("POST", "/doc", { source: "memory", name: "big", body: big })).status).toBe(
      413,
    );
    const ok = await call("POST", "/doc", { source: "memory", name: "small", body: "x" });
    const res = await call("PUT", "/doc", {
      id: ok.json.doc.id,
      body: big,
      mtime: ok.json.doc.mtime,
    });
    expect(res.status).toBe(413);
    await call("DELETE", "/doc", { id: ok.json.doc.id });
  });

  test("create never writes through an existing or dangling symlink", async () => {
    const prompts = join(roots.dataDir, "prompts");
    mkdirSync(prompts, { recursive: true });
    symlinkSync(join(dir, "nowhere.md"), join(prompts, "dangling.md"));
    symlinkSync(join(dir, "elsewhere", "leak.md"), join(prompts, "taken.md"));
    expect(
      (await call("POST", "/doc", { source: "prompts", name: "dangling", body: "x" })).status,
    ).toBe(409);
    expect(
      (await call("POST", "/doc", { source: "prompts", name: "taken", body: "x" })).status,
    ).toBe(409);
    expect(() => statSync(join(dir, "nowhere.md"))).toThrow();
    expect(readFileSync(join(dir, "elsewhere", "leak.md"), "utf8")).toBe("leaked text zebra");
    rmSync(join(prompts, "dangling.md"));
    rmSync(join(prompts, "taken.md"));
  });

  test("a symlinked source folder is refused for every write", async () => {
    const other = join(dir, "other-notes");
    mkdirSync(other, { recursive: true });
    const linkedRoots = { ...roots, dataDir: join(dir, "data-linked") };
    mkdirSync(linkedRoots.dataDir, { recursive: true });
    symlinkSync(other, join(linkedRoots.dataDir, "notes"));
    writeFileSync(join(other, "x.md"), "x");
    const s = new MemoryStore(openDb(":memory:"), memorySources(linkedRoots), linkedRoots.dataDir);
    await expect(s.create("notes", "y", "y")).rejects.toMatchObject({ status: 403 });
    expect(readdirSync(other)).toEqual(["x.md"]);
  });

  test("a note swapped for a symlink is refused on update and delete", async () => {
    const created = await call("POST", "/doc", { source: "notes", name: "swap", body: "x" });
    const { id, mtime } = created.json.doc;
    const path = join(roots.dataDir, "notes", "swap.md");
    // Prime the index with the regular file, then swap it without another walk seeing it.
    const s = new MemoryStore(openDb(":memory:"), memorySources(roots), roots.dataDir);
    await s.refresh();
    rmSync(path);
    symlinkSync(join(dir, "elsewhere", "leak.md"), path);
    // The walk drops a symlink, so the id is unknown: 404, and the target is untouched.
    await expect(s.update(id, "pwned", mtime)).rejects.toMatchObject({ status: 404 });
    await expect(s.remove(id)).rejects.toMatchObject({ status: 404 });
    expect(readFileSync(join(dir, "elsewhere", "leak.md"), "utf8")).toBe("leaked text zebra");
    rmSync(path);
  });
});

test("note deletion requires the displayed content and preserves a recoverable copy", async () => {
  const s = store();
  const doc = await s.create("notes", `recovery-${crypto.randomUUID()}`, "first\n");
  await expect(s.remove(doc.id, doc.mtime, contentVersion("wrong"))).rejects.toMatchObject({
    code: "stale",
  });
  const recovery = await s.remove(doc.id, doc.mtime, contentVersion(doc.body));
  expect(readFileSync(join(roots.dataDir, "recovery", recovery, "content"), "utf8")).toBe(
    "first\n",
  );
  await expect(s.get(doc.id)).rejects.toMatchObject({ status: 404 });
});

describe("work bar", () => {
  test("lists the saved prompts marked bar: true, by order and then title", async () => {
    const r = { home: join(dir, "bar-home"), dataDir: join(dir, "bar-data"), repos: [] };
    const prompts = join(r.dataDir, "prompts");
    put(
      join(prompts, "tests.md"),
      "---\ndescription: Runs them all\nbar: true\nlabel: Tests\norder: 2\n---\nRun the tests",
    );
    put(join(prompts, "review.md"), "---\nbar: true\norder: 1\n---\n# Revisión\nReview it");
    put(join(prompts, "context.md"), "---\nbar: true\n---\n# Contexto\nCheck the context");
    put(join(prompts, "draft.md"), "---\nbar: false\n---\nNot on the bar");
    put(join(prompts, "plain.md"), "No frontmatter");
    const s = new MemoryStore(openDb(":memory:"), memorySources(r), r.dataDir);
    expect(await s.bar()).toEqual([
      {
        id: "prompts:review.md",
        title: "Revisión",
        label: undefined,
        order: 1,
        description: undefined,
      },
      {
        id: "prompts:tests.md",
        title: "tests",
        label: "Tests",
        order: 2,
        description: "Runs them all",
      },
      {
        id: "prompts:context.md",
        title: "Contexto",
        label: undefined,
        order: undefined,
        description: undefined,
      },
    ]);
  });

  test("the miner prompt is seeded on the bar once, with absolute paths, and never overwritten", async () => {
    const r = { home: join(dir, "seed-home"), dataDir: join(dir, "seed-data"), repos: [] };
    const s = new MemoryStore(openDb(":memory:"), memorySources(r), r.dataDir);
    await seedMiner(s, "/app", r.dataDir);
    const [button] = await s.bar();
    expect(button).toMatchObject({ id: "prompts:Minar rituales.md", title: "Minar rituales" });
    const doc = await s.get("prompts:Minar rituales.md");
    expect(doc.body).toContain('bun "/app/scripts/mine-rituals.ts"');
    expect(doc.body).toContain(join(r.dataDir, "prompts"));
    expect(variablesIn(doc.body)).toEqual([]);
    await s.update(doc.id, "---\nbar: false\n---\nMine", doc.mtime);
    await seedMiner(s, "/app", r.dataDir);
    expect((await s.get(doc.id)).body).toBe("---\nbar: false\n---\nMine");
    expect(await s.bar()).toEqual([]);
  });
});
