import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { FileError } from "../files/browse.ts";
import { cleanEnv } from "../terminals/env.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { findDefinition, parseGrep, patterns, rank } from "./definition.ts";
import { listAllFiles } from "./files.ts";
import { type CodeWhere, listCode, READ_LIMIT, readCode, statCode } from "./read.ts";
import { writeCode } from "./write.ts";

const GIT = "/usr/bin/git";
let root: string;
let repo: string;
let envRoot: string;
const env = () => ({ PATH: "/usr/bin:/bin", HOME: root });
const at = (cwd: string, bin: string | null = GIT): CodeWhere => ({ bin, cwd, env: env() });
const read = async (rel: string) => readCode(await statCode(at(repo), rel));

const write = (path: string, text: string | Uint8Array) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const init = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync([GIT, "init", "-q"], { cwd: dir, env: env() });
};

const A_TS = [
  "import { other } from './b';",
  "",
  "export function hello(name: string) {",
  "  return 'hi ' + name;",
  "}",
  "",
  "export const value = 42;",
  "",
  "export class Thing {",
  "  method(x: number) {",
  "    return hello(String(x));",
  "  }",
  "}",
  "export const handlers = {",
  "  arrow: () => 1,",
  "};",
  "",
].join("\n");

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "aos-code-")));
  repo = join(root, "repo");
  init(repo);
  write(join(repo, "src", "a.ts"), A_TS);
  write(
    join(repo, "src", "b.ts"),
    [
      "import { hello } from './a';",
      "hello('b');",
      "// The class Thing in a.ts says hello.",
      "// arrow = () => 2 was the old handler.",
      'expect(text).toContain("export function hello(");',
      "",
    ].join("\n"),
  );
  write(join(repo, "py", "m.py"), "CONSTANT = 1\n\ndef greet(who):\n    return who\n");
  write(join(repo, ".gitignore"), "dist/\n*.log\n");
  write(join(repo, "dist", "out.js"), "function hello() {}\n");
  write(join(repo, "x.log"), "log\n");
  write(join(repo, ".github", "w.yml"), "on: push\n");
  write(join(repo, "bin.dat"), new Uint8Array([1, 2, 0, 3]));
  // What the saves write to, and a Latin-1 file (not UTF-8: read only).
  write(join(repo, "edit", "latin1.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  write(join(repo, "big.txt"), "x".repeat(READ_LIMIT + 1));
  write(join(root, "outside", "secret.txt"), "secret\n");
  write(join(root, "repo2", "x.txt"), "sibling\n");
  symlinkSync(join(root, "outside", "secret.txt"), join(repo, "link-out"));
  symlinkSync(join(repo, "src", "a.ts"), join(repo, "link-in"));
  // An env: no repo at its root, one checkout below it.
  envRoot = join(root, "env");
  init(join(envRoot, "front"));
  write(join(envRoot, "front", "f.ts"), "export type Front = string;\n");
  write(join(envRoot, "front", ".gitignore"), "build/\n");
  write(join(envRoot, "front", "build", "x.js"), "x\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => (err instanceof FileError ? { status: err.status, code: err.code } : err),
  );

describe("readCode", () => {
  test("a text file with its digest; a link inside the checkout reads too", async () => {
    const f = await read("src/a.ts");
    expect(f).toMatchObject({ kind: "text", path: "src/a.ts", text: A_TS, size: A_TS.length });
    expect(f.kind === "text" && f.digest).toMatch(/^[0-9a-f]{40}$/);
    expect(await read("link-in")).toMatchObject({ kind: "text", text: A_TS });
    expect(await read("./src//a.ts")).toMatchObject({ path: "src/a.ts" });
  });

  test("editable: valid UTF-8 outside .git; other bytes and git's own files are read only", async () => {
    expect(await read("src/a.ts")).toMatchObject({ editable: true });
    expect(await read("edit/latin1.txt")).toMatchObject({ kind: "text", editable: false });
    expect(await read(".git/HEAD")).toMatchObject({ kind: "text", editable: false });
  });

  test("binary and too large come back as such, with no text", async () => {
    expect(await read("bin.dat")).toEqual({
      kind: "binary",
      path: "bin.dat",
      size: 4,
      version: expect.stringMatching(/^W\/"4-\d+"$/),
    });
    expect(await read("big.txt")).toEqual({
      kind: "too_large",
      path: "big.txt",
      size: READ_LIMIT + 1,
      version: expect.stringMatching(/^W\/"\d+-\d+"$/),
    });
  });

  test("nothing above the checkout: .., absolute, a link out, a sibling with the same prefix", async () => {
    const outside = { status: 403, code: "outside" };
    for (const rel of [
      "..",
      "../outside/secret.txt",
      "src/../../outside/secret.txt",
      "../repo2/x.txt",
      "/etc/hosts",
      "link-out",
    ]) {
      expect(await fail(read(rel))).toEqual(outside);
    }
    // Refused before the disk is asked: a missing file outside is not said to be missing.
    expect(await fail(read("../nope.txt"))).toEqual(outside);
  });

  test("a folder is not a file and a missing file is not found", async () => {
    expect(await fail(read("src"))).toEqual({ status: 400, code: "not_a_file" });
    expect(await fail(read("src/zz.ts"))).toEqual({ status: 404, code: "not_found" });
  });
});

describe("writeCode", () => {
  const where = () => at(repo);
  const version = async (rel: string) => (await statCode(where(), rel)).version;
  const leftovers = (dir: string) => readdirSync(join(repo, dir)).filter((n) => n.endsWith(".tmp"));

  test("saves over the version it opened; the answer is the new version; +x and no temp kept", async () => {
    write(join(repo, "edit", "run.sh"), "#!/bin/sh\necho one\n");
    chmodSync(join(repo, "edit", "run.sh"), 0o755);
    const saved = await writeCode(
      where(),
      "edit/run.sh",
      "#!/bin/sh\necho dos ñ\n",
      await version("edit/run.sh"),
    );
    expect(readFileSync(join(repo, "edit", "run.sh"), "utf8")).toBe("#!/bin/sh\necho dos ñ\n");
    expect(saved.version).toBe(await version("edit/run.sh"));
    expect(saved.size).toBe(Buffer.byteLength("#!/bin/sh\necho dos ñ\n"));
    expect(await read("edit/run.sh")).toMatchObject({ digest: saved.digest });
    expect(statSync(join(repo, "edit", "run.sh")).mode & 0o777).toBe(0o755);
    expect(leftovers("edit")).toEqual([]);
  });

  test("a file changed since it was opened is not saved over: 409 stale", async () => {
    write(join(repo, "edit", "s.txt"), "one\n");
    const opened = await version("edit/s.txt");
    write(join(repo, "edit", "s.txt"), "agent wrote this\n");
    expect(await fail(writeCode(where(), "edit/s.txt", "mine\n", opened))).toEqual({
      status: 409,
      code: "stale",
    });
    expect(readFileSync(join(repo, "edit", "s.txt"), "utf8")).toBe("agent wrote this\n");
  });

  test("two saves from the same version: the first lands, the second is stale", async () => {
    write(join(repo, "edit", "race.txt"), "zero\n");
    const opened = await version("edit/race.txt");
    const [a, b] = await Promise.all([
      fail(writeCode(where(), "edit/race.txt", "a\n", opened)),
      fail(writeCode(where(), "edit/race.txt", "b\n", opened)),
    ]);
    expect([a, b]).toEqual([null, { status: 409, code: "stale" }]);
    expect(readFileSync(join(repo, "edit", "race.txt"), "utf8")).toBe("a\n");
  });

  test("refused: .git, out of the checkout, missing, binary, not UTF-8, too large", async () => {
    const save = async (rel: string, text = "x\n") =>
      fail(writeCode(where(), rel, text, await version(rel).catch(() => 'W/"0-0"')));
    expect(await save(".git/HEAD")).toEqual({ status: 403, code: "no_access" });
    expect(await save("../outside/secret.txt")).toEqual({ status: 403, code: "outside" });
    expect(await save("link-out")).toEqual({ status: 403, code: "outside" });
    expect(await save("edit/none.txt")).toEqual({ status: 404, code: "not_found" });
    expect(await save("bin.dat")).toEqual({ status: 409, code: "not_editable" });
    expect(await save("edit/latin1.txt")).toEqual({ status: 409, code: "not_editable" });
    expect(await save("big.txt")).toEqual({ status: 409, code: "not_editable" });
    expect(await save("edit/s.txt", "x".repeat(READ_LIMIT + 1))).toEqual({
      status: 413,
      code: "too_large",
    });
    expect(readFileSync(join(root, "outside", "secret.txt"), "utf8")).toBe("secret\n");
  });
});

describe("listCode", () => {
  test("folders first, dot entries but never .git, what git ignores marked", async () => {
    const l = await listCode(at(repo), "");
    expect(l.dir).toBe("");
    expect(l.entries.map((e) => `${e.kind[0]}:${e.name}${e.ignored ? " (ignored)" : ""}`)).toEqual([
      "f:.github",
      "f:dist (ignored)",
      "f:edit",
      "f:py",
      "f:src",
      "f:.gitignore",
      "f:big.txt",
      "f:bin.dat",
      "f:link-in",
      "f:link-out",
      "f:x.log (ignored)",
    ]);
    expect(l.entries.find((e) => e.name === "dist")?.kind).toBe("folder");
    expect((await listCode(at(repo), "src")).entries.map((e) => e.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("an env's root has no ignore marks; its checkout has its own", async () => {
    const top = await listCode(at(envRoot), "");
    expect(top.entries).toEqual([{ name: "front", path: "front", kind: "folder", ignored: false }]);
    const front = await listCode(at(envRoot), "front");
    expect(front.entries.find((e) => e.name === "build")?.ignored).toBe(true);
    expect(front.entries.find((e) => e.name === "f.ts")?.ignored).toBe(false);
  });

  test("without git it still lists, with no marks; a folder out of the checkout is refused", async () => {
    const l = await listCode(at(repo, null), "");
    expect(l.entries.some((e) => e.ignored)).toBe(false);
    expect(await fail(listCode(at(repo), "../outside"))).toEqual({ status: 403, code: "outside" });
  });
});

describe("listAllFiles", () => {
  test("tracked and untracked, never ignored", async () => {
    const { files, truncated, git } = await listAllFiles(at(repo));
    expect(git).toBe(true);
    expect(truncated).toBe(false);
    expect(files).toContain("src/a.ts");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain("dist/out.js");
    expect(files).not.toContain("x.log");
  });

  test("an env's checkouts one level down, prefixed; no git, no list", async () => {
    expect((await listAllFiles(at(envRoot))).files.sort()).toEqual([
      "front/.gitignore",
      "front/f.ts",
    ]);
    expect(await listAllFiles(at(repo, null))).toEqual({ files: [], truncated: false, git: false });
  });
});

describe("findDefinition", () => {
  const def = async (from: string, name: string, cwd = repo) =>
    (await findDefinition(at(cwd), from, name)).hits.map((h) => `${h.path}:${h.line}`);

  test("a function, a const, a class and a method, from another file", async () => {
    expect((await def("src/b.ts", "hello"))[0]).toBe("src/a.ts:3");
    expect(await def("src/b.ts", "value")).toEqual(["src/a.ts:7"]);
    expect(await def("src/b.ts", "Thing")).toEqual(["src/a.ts:9"]);
    expect(await def("src/a.ts", "method")).toEqual(["src/a.ts:10"]);
  });

  test("Python defs and module assignments; ignored files are not searched", async () => {
    expect(await def("py/m.py", "greet")).toEqual(["py/m.py:3"]);
    expect(await def("py/m.py", "CONSTANT")).toEqual(["py/m.py:1"]);
    expect(await def("src/b.ts", "hello")).not.toContain("dist/out.js:1");
    expect(await def("src/b.ts", "nothingNamedThis")).toEqual([]);
  });

  test("a declaration quoted in a string or named in a comment is not one", async () => {
    expect(await def("src/b.ts", "hello")).toEqual(["src/a.ts:3"]);
    expect(await def("src/b.ts", "Thing")).toEqual(["src/a.ts:9"]);
    expect(await def("src/b.ts", "arrow")).toEqual(["src/a.ts:15"]);
  });

  test("inside an env's checkout, paths stay the env's", async () => {
    expect(await def("front/f.ts", "Front", envRoot)).toEqual(["front/f.ts:1"]);
  });

  test("no git, no search", async () => {
    expect(await findDefinition(at(repo, null), "src/a.ts", "hello")).toEqual({
      hits: [],
      git: false,
    });
  });
});

describe("grep output", () => {
  test("rows parse and rank: keyword hits, then the open file, its folder, the rest", () => {
    expect(parseGrep("a.ts\x003\x00export function x() {\nbad row\n")).toEqual([
      { path: "a.ts", line: 3, text: "export function x() {" },
    ]);
    const h = (path: string, line: number, strong: boolean) => ({ path, line, text: "", strong });
    const ranked = rank(
      [
        h("z/y.ts", 1, false),
        h("lib/q.ts", 2, true),
        h("src/a.ts", 5, false),
        h("src/b.ts", 1, false),
      ],
      "src/a.ts",
    );
    expect(ranked.map((r) => `${r.path}:${r.line}`)).toEqual([
      "lib/q.ts:2",
      "src/a.ts:5",
      "src/b.ts:1",
      "z/y.ts:1",
    ]);
  });

  test("a name with $ is escaped for the regex", () => {
    expect(patterns("$el").strong[0]).toContain("\\$el");
  });
});

describe("routes", () => {
  const make = () => {
    const config = ConfigSchema.parse({
      port: 4317,
      terminals: { shell: "/bin/sh" },
      repos: [{ id: "r", localPath: repo }],
    });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () =>
      Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {})),
    );
    return createApp({ config, db, terminals, tokens: new AttachTokens() });
  };
  let app: ReturnType<typeof make> | undefined;
  const get = async (path: string) => {
    app ??= make();
    const res = await app.request(`/api/code${path}`, { headers: { host: "127.0.0.1:4317" } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

  test("a location id, never a path: tree, file, files and definition", async () => {
    const tree = await get(`/tree?${q({ location: "repo:r" })}`);
    expect(tree.status).toBe(200);
    expect(tree.json.dir).toBe("");
    const file = await get(`/file?${q({ location: "repo:r", path: "src/a.ts" })}`);
    expect(file.json).toMatchObject({ kind: "text", text: A_TS });
    const files = await get(`/files?${q({ location: "repo:r" })}`);
    expect(files.json.files).toContain("src/b.ts");
    const found = await get(
      `/definition?${q({ location: "repo:r", path: "src/b.ts", name: "hello" })}`,
    );
    expect((found.json.hits as { path: string }[])[0]?.path).toBe("src/a.ts");
  });

  test("a poll with the file's ETag gets a 304; an edit changes the ETag", async () => {
    app ??= make();
    const url = `/api/code/file?${q({ location: "repo:r", path: "py/m.py" })}`;
    const ask = (etag?: string) =>
      (app as ReturnType<typeof make>).request(url, {
        headers: { host: "127.0.0.1:4317", ...(etag && { "if-none-match": etag }) },
      });
    const first = await ask();
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\/"\d+-\d+"$/);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const again = await ask(etag);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    write(join(repo, "py", "m.py"), "CONSTANT = 1\n\ndef greet(who):\n    return who\n\n");
    const edited = await ask(etag);
    expect(edited.status).toBe(200);
    expect(edited.headers.get("etag")).not.toBe(etag);
  });

  test("raw serves images only, sandboxed, and never from outside", async () => {
    app ??= make();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    write(join(repo, "img", "dot.png"), png);
    try {
      const raw = (path: string) =>
        (app as ReturnType<typeof make>).request(
          `/api/code/raw?${q({ location: "repo:r", path })}`,
          { headers: { host: "127.0.0.1:4317" } },
        );
      const ok = await raw("img/dot.png");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      expect(ok.headers.get("content-security-policy")).toContain("sandbox");
      expect(Buffer.from(await ok.arrayBuffer()).equals(png)).toBe(true);
      expect((await raw("src/a.ts")).status).toBe(415);
      expect((await raw("../outside/x.png")).status).toBe(403);
      expect((await raw("img/none.png")).status).toBe(404);
    } finally {
      rmSync(join(repo, "img"), { recursive: true, force: true });
    }
  });

  test("PUT saves through the local guard; a stale base is a 409", async () => {
    app ??= make();
    write(join(repo, "edit", "r.txt"), "one\n");
    const base = (await statCode(at(repo), "edit/r.txt")).version;
    const put = (body: unknown, type = "application/json") =>
      (app as ReturnType<typeof make>).request("/api/code/file", {
        method: "PUT",
        headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", "content-type": type },
        body: JSON.stringify(body),
      });
    const ok = await put({ location: "repo:r", path: "edit/r.txt", text: "two\n", base });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { version: string }).version).not.toBe(base);
    expect(readFileSync(join(repo, "edit", "r.txt"), "utf8")).toBe("two\n");
    const stale = await put({ location: "repo:r", path: "edit/r.txt", text: "three\n", base });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("stale");
    expect((await put({ location: "repo:r", path: "edit/r.txt", text: 3, base })).status).toBe(400);
    expect(
      (await put({ location: "repo:r", path: "edit/r.txt", text: "x", base }, "text/plain")).status,
    ).toBe(415);
    expect(readFileSync(join(repo, "edit", "r.txt"), "utf8")).toBe("two\n");
  });

  test("refusals: out of the checkout, a bad name, an unknown location", async () => {
    expect(await get(`/file?${q({ location: "repo:r", path: "../outside/secret.txt" })}`)).toEqual({
      status: 403,
      json: { error: "outside", detail: "La ruta sale del checkout." },
    });
    const name = await get(
      `/definition?${q({ location: "repo:r", path: "src/a.ts", name: "a b" })}`,
    );
    expect(name.status).toBe(400);
    expect((await get(`/tree?${q({ location: "repo:nope" })}`)).status).toBe(400);
    expect((await get("/file?location=repo%3Ar")).status).toBe(400);
  });

  test("a reveal goes through the local guard and the place's own checks, and reads back", async () => {
    app ??= make();
    const ask = (body: unknown, origin = "http://127.0.0.1:4317") =>
      (app as ReturnType<typeof make>).request("/api/code/reveal", {
        method: "POST",
        headers: { host: "127.0.0.1:4317", origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await ask({ location: "repo:r", path: "src/a.ts" }, "http://evil.example")).status,
    ).toBe(403);
    expect(
      (await ask({ location: "repo:r", path: "../outside.ts" })).status,
    ).toBeGreaterThanOrEqual(400);
    const sent = await ask({ location: "repo:r", path: "src/a.ts", line: 5 });
    expect(sent.status).toBe(200);
    const { id, delivered } = (await sent.json()) as { id: string; delivered: boolean };
    expect(delivered).toBe(false);
    const read = await get("/reveal");
    expect(read.json).toEqual({ id, location: "repo:r", path: "src/a.ts", line: 5 });
  });
});
