import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../config.ts";
import { GitRefusal } from "../git/sync.ts";
import type { TerminalInfo } from "../terminals/contract.ts";
import { addRepo, removeRepo, repoId } from "./places.ts";

const GIT = "/usr/bin/git";
let dir: string;
let configPath: string;
let gitEnv: Record<string, string>;

const initRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  const r = Bun.spawnSync([GIT, "init", "-q", "-b", "main"], { cwd: path, env: gitEnv });
  if (r.exitCode !== 0) throw new Error("git init failed");
  return realpathSync(path);
};

// The file as the user keeps it, with a key the app must not drop.
const writeConfig = (repos: unknown[]) =>
  writeFileSync(configPath, JSON.stringify({ notesDir: "/notes", repos }));
const fileRepos = () => JSON.parse(readFileSync(configPath, "utf8")).repos;
const configFromFile = () => ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));

const noTerminals = { list: async (): Promise<TerminalInfo[]> => [] };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-places-")));
  configPath = join(dir, "config.json");
  gitEnv = {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("repoId", () => {
  test("a config-style id from the folder name, unique among the repos", () => {
    expect(repoId("My Repo.v2", [])).toBe("my-repo-v2");
    expect(repoId("web", ["web", "web-2"])).toBe("web-3");
    expect(repoId("ñ", [])).toBe("repo");
  });
});

describe("addRepo", () => {
  test("adds a git root as a local-only repo, keeps the rest of the file and the running config", async () => {
    const work = initRepo(join(dir, "work"));
    const mine = initRepo(join(dir, "Mine"));
    writeConfig([{ id: "work", localPath: work, group: "Team" }]);
    const config = configFromFile();
    const repo = await addRepo(config, gitEnv, `${mine}/`, configPath);
    expect(repo).toMatchObject({ id: "mine", localPath: mine });
    expect(fileRepos()).toEqual([
      { id: "work", localPath: work, group: "Team" },
      { id: "mine", localPath: mine },
    ]);
    expect(JSON.parse(readFileSync(configPath, "utf8")).notesDir).toBe("/notes");
    expect(config.repos.map((r) => r.id)).toEqual(["work", "mine"]);
  });

  test("refuses what is not a repo root, or sits inside or around another repo", async () => {
    const work = initRepo(join(dir, "work"));
    mkdirSync(join(work, "sub"));
    mkdirSync(join(dir, "plain"));
    writeConfig([{ id: "work", localPath: work }]);
    const config = configFromFile();
    const reason = (path: string) =>
      addRepo(config, gitEnv, path, configPath).then(
        () => null,
        (err: unknown) => (err instanceof GitRefusal ? err.reason : String(err)),
      );
    expect(await reason("relative/path")).toBe("bad_folder");
    expect(await reason(join(dir, "missing"))).toBe("bad_folder");
    expect(await reason(join(dir, "plain"))).toBe("not_a_repo");
    expect(await reason(join(work, "sub"))).toBe("not_a_repo");
    initRepo(join(work, "nested"));
    expect(await reason(join(work, "nested"))).toBe("overlaps");
    expect(fileRepos()).toHaveLength(1);
  });

  test("the app's own folder can be added as it is, never what is inside or around it", async () => {
    const app = initRepo(join(dir, "agentic-os"));
    initRepo(join(app, "inner"));
    writeConfig([]);
    const config = configFromFile();
    const add = (path: string) =>
      addRepo(config, gitEnv, path, configPath, app).then(
        (r) => r.id,
        (err: unknown) => (err instanceof GitRefusal ? err.reason : String(err)),
      );
    expect(await add(join(app, "inner"))).toBe("overlaps");
    expect(await add(app)).toBe("agentic-os");
    // Once listed, it is a repo like any other: a second time overlaps.
    expect(await add(app)).toBe("overlaps");
    expect(fileRepos()).toEqual([{ id: "agentic-os", localPath: app }]);
  });
});

describe("removeRepo", () => {
  test("takes an added repo off the list and leaves the folder", async () => {
    const mine = initRepo(join(dir, "mine"));
    writeConfig([{ id: "mine", localPath: mine }]);
    const config = configFromFile();
    await removeRepo(config, noTerminals, "mine", configPath);
    expect(fileRepos()).toEqual([]);
    expect(config.repos).toEqual([]);
    expect(Bun.file(join(mine, ".git", "HEAD")).size).toBeGreaterThan(0);
  });

  test("refuses a grouped or GitHub repo, and one with a terminal running inside", async () => {
    const mine = initRepo(join(dir, "mine"));
    const team = initRepo(join(dir, "team"));
    writeConfig([
      { id: "mine", localPath: mine },
      { id: "team", localPath: team, group: "Team" },
    ]);
    const config = configFromFile();
    const reason = (id: string, terminals = noTerminals) =>
      removeRepo(config, terminals, id, configPath).then(
        () => null,
        (err: unknown) => (err instanceof GitRefusal ? err.reason : String(err)),
      );
    expect(await reason("team")).toBe("not_removable");
    expect(await reason("nope")).toBe("not_removable");
    const busy = {
      list: async () => [{ state: "running", cwd: join(mine, "src") } as TerminalInfo],
    };
    expect(await reason("mine", busy)).toBe("terminal_inside");
    expect(fileRepos()).toHaveLength(2);
  });
});
