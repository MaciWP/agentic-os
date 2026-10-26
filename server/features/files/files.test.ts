import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { cleanEnv } from "../terminals/env.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { commonParent, driveRoots, FileError, listFolders, places } from "./browse.ts";

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "aos-files-")));
  // repo (a .git folder), wt (a .git file, as in a worktree), plain, a file, a hidden folder,
  // a link to a folder and a link to a file; numbered names to check the order.
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "wt"));
  writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere\n");
  for (const name of ["plain", "item10", "item9", ".hidden", "Zeta"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "notes.txt"), "x");
  symlinkSync(join(root, "repo"), join(root, "linked"));
  symlinkSync(join(root, "notes.txt"), join(root, "file-link"));
  mkdirSync(join(root, "closed"));
});

afterAll(() => {
  chmodSync(join(root, "closed"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => (err instanceof FileError ? { status: err.status, code: err.code } : err),
  );

describe("listFolders", () => {
  test("lists folders only, by name, with the git ones marked", async () => {
    const l = await listFolders(root);
    expect(l.path).toBe(root);
    expect(l.parent).toBe(join(root, ".."));
    expect(l.git).toBe(false);
    expect(l.truncated).toBe(false);
    // No files, no hidden folder, no link to a file; numbers in order, case ignored.
    expect(l.entries.map((e) => e.name)).toEqual([
      "closed",
      "item9",
      "item10",
      "linked",
      "plain",
      "repo",
      "wt",
      "Zeta",
    ]);
    const git = Object.fromEntries(l.entries.map((e) => [e.name, e.git]));
    expect(git).toMatchObject({ repo: true, wt: true, linked: true, plain: false });
    expect(l.entries[0]).toEqual({
      name: "closed",
      path: join(root, "closed"),
      kind: "folder",
      git: false,
    });
  });

  test("a folder that is a repo says so, and the root has no parent", async () => {
    expect((await listFolders(join(root, "repo"))).git).toBe(true);
    expect((await listFolders("/")).parent).toBeNull();
  });

  test("caps a long listing and says it was cut", async () => {
    const l = await listFolders(root, { limit: 3 });
    expect(l.entries.map((e) => e.name)).toEqual(["closed", "item9", "item10"]);
    expect(l.truncated).toBe(true);
  });

  test("refuses in words what it cannot list", async () => {
    expect(await fail(listFolders("relative/path"))).toEqual({ status: 400, code: "not_absolute" });
    expect(await fail(listFolders(join(root, "missing")))).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await fail(listFolders(join(root, "notes.txt")))).toEqual({
      status: 400,
      code: "not_a_folder",
    });
    chmodSync(join(root, "closed"), 0o000);
    expect(await fail(listFolders(join(root, "closed")))).toEqual({
      status: 403,
      code: "no_access",
    });
    chmodSync(join(root, "closed"), 0o755);
  });
});

describe("places", () => {
  test("the deepest folder holding every path, or none above the root", () => {
    expect(commonParent(["/a/b/c", "/a/b/d", "/a/b"])).toBe("/a/b");
    expect(commonParent(["/a/b", "/c/d"])).toBeNull();
    expect(commonParent([])).toBeNull();
  });

  test("on Windows the drive is the root: one drive gives its folder, two drives give none", () => {
    const w = path.win32;
    expect(commonParent(["D:\\PYTHON\\a", "D:\\PYTHON\\b"], w)).toBe("D:\\PYTHON");
    expect(commonParent(["D:\\a", "D:\\b"], w)).toBeNull();
    expect(commonParent(["C:\\x\\a", "D:\\x\\a"], w)).toBeNull();
  });

  test("the repos' folder first, then home and the roots, each once and only if it exists", async () => {
    const config = ConfigSchema.parse({
      port: 4317,
      repos: [
        { id: "a", localPath: join(root, "repo") },
        { id: "b", localPath: join(root, "wt") },
      ],
      worktrees: { root: join(root, "missing") },
    });
    expect(await places(config, root)).toEqual([{ id: "repos", label: "Repos", path: root }]);
    expect(await places(config, join(root, "plain"))).toEqual([
      { id: "repos", label: "Repos", path: root },
      { id: "home", label: "Inicio", path: join(root, "plain") },
    ]);
  });
});

test("Windows offers each drive root; other systems none", () => {
  const roots = driveRoots("win32");
  expect(roots[0]).toEqual({ id: "drive-c", label: "C:", path: "C:\\" });
  expect(roots.map((r) => r.label)).toContain("D:");
  expect(driveRoots("darwin")).toEqual([]);
});

describe("routes", () => {
  const make = () => {
    const config = ConfigSchema.parse({ port: 4317, terminals: { shell: "/bin/sh" } });
    const db = openDb(":memory:");
    const terminals = new TerminalManager(config, db, () =>
      Promise.resolve(cleanEnv({ PATH: "/bin" }, {})),
    );
    return createApp({ config, db, terminals, tokens: new AttachTokens() });
  };
  let app: ReturnType<typeof make> | undefined;
  const get = async (path: string) => {
    app ??= make();
    const res = await app.request(`/api/files${path}`, { headers: { host: "127.0.0.1:4317" } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  test("a listing, its refusals with their status, and a bad query", async () => {
    const ok = await get(`/folders?path=${encodeURIComponent(root)}`);
    expect(ok.status).toBe(200);
    expect(ok.json.path).toBe(root);
    expect(await get(`/folders?path=${encodeURIComponent(join(root, "missing"))}`)).toEqual({
      status: 404,
      json: { error: "not_found", detail: `No existe la carpeta ${join(root, "missing")}.` },
    });
    expect((await get("/folders")).status).toBe(400);
    const listed = await get("/places");
    expect(listed.status).toBe(200);
    expect(typeof listed.json.home).toBe("string");
  });
});
