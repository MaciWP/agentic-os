import { describe, expect, test } from "bun:test";
import { createApp } from "./app.ts";
import { ConfigSchema, checkBins, configSchema, onGithub } from "./config.ts";
import { openDb } from "./db.ts";
import { githubClient } from "./features/github/prs.ts";
import { TerminalManager } from "./features/terminals/pty.ts";
import { AttachTokens } from "./features/terminals/ws-guard.ts";

const jira = { site: "https://example.atlassian.net", project: "ABC" };
const local = { id: "notes", localPath: "/tmp" };
const remote = { id: "api", owner: "acme", name: "api", login: "me", localPath: "/tmp" };

describe("providers", () => {
  test("Jira is on when its section is present, and off when the profile says so", () => {
    expect(ConfigSchema.parse({ jira }).providers.jira).toBe(true);
    expect(ConfigSchema.parse({}).providers.jira).toBe(false);
    const off = ConfigSchema.parse({ jira, providers: { jira: false } });
    expect(off.providers.jira).toBe(false);
    // Dropped, so every `config.jira` check reads as "off".
    expect(off.jira).toBeUndefined();
  });

  test("the effort judge's Monday pass is off unless the config turns it on", () => {
    expect(ConfigSchema.parse({}).usage.judgeAuto).toBe(false);
    expect(ConfigSchema.parse({ usage: { judgeAuto: true } }).usage.judgeAuto).toBe(true);
  });

  test("the image history needs no section; a screenshots folder must be absolute", () => {
    // The clipboard watcher stays off unless switched on; ⌃⌘4 is on unless switched off.
    expect(ConfigSchema.parse({}).images).toEqual({ watchClipboard: false, captureHotkey: true });
    expect(ConfigSchema.parse({}).system).toEqual({ screenWhileAgentsWork: false });
    expect(ConfigSchema.parse({ images: { watchClipboard: true } }).images.watchClipboard).toBe(
      true,
    );
    expect(ConfigSchema.parse({ images: { screenshotsDir: "/shots" } }).images.screenshotsDir).toBe(
      "/shots",
    );
    expect(ConfigSchema.safeParse({ images: { screenshotsDir: "shots" } }).success).toBe(false);
  });

  test("Jira boards: none by default, each with columns, ids never repeated", () => {
    expect(ConfigSchema.parse({ jira }).jira?.boards).toEqual([]);
    const board = { id: "sprint", name: "Sprint", columns: [{ name: "PR", statuses: ["20004"] }] };
    const parse = (boards: object[]) => ConfigSchema.safeParse({ jira: { ...jira, boards } });
    expect(parse([board]).success).toBe(true);
    expect(parse([board, board]).success).toBe(false);
    expect(parse([{ ...board, columns: [] }]).success).toBe(false);
    expect(parse([{ ...board, columns: [{ name: "PR", statuses: [] }] }]).success).toBe(false);
    expect(parse([{ ...board, id: "Sprint 1" }]).success).toBe(false);
    // Ids only: a name would reach the JQL unquoted, and Jira matches untranslated names.
    expect(
      parse([{ ...board, columns: [{ name: "PR", statuses: ["Pull Request"] }] }]).success,
    ).toBe(false);
  });

  test("Jira switched on without its section is a config error", () => {
    expect(ConfigSchema.safeParse({ providers: { jira: true } }).success).toBe(false);
  });

  test("a repo has all of owner, name and login, or none of them", () => {
    const parse = (repo: object) => ConfigSchema.safeParse({ repos: [repo] }).success;
    expect(parse(local)).toBe(true);
    expect(parse(remote)).toBe(true);
    expect(parse({ ...local, owner: "acme", name: "api" })).toBe(false);
    expect(ConfigSchema.parse({ repos: [local, remote] }).repos.filter(onGithub)).toHaveLength(1);
  });

  test("the PR inbox never searches a local-only repo", async () => {
    const config = ConfigSchema.parse({
      repos: [local, remote],
      github: { bin: "/usr/bin/gh-fake" },
    });
    const queries: string[] = [];
    const client = githubClient(config, {
      run: async (argv) => {
        const path = String(argv.at(-1));
        if (path === "/user") return { code: 0, out: 'HTTP/2.0 200 OK\n\n{"login":"me"}' };
        queries.push(new URL(path, "https://api.github.com").searchParams.get("q") ?? "");
        return { code: 0, out: 'HTTP/2.0 200 OK\n\n{"items":[]}' };
      },
    });
    expect(await client.list()).toEqual({ prs: [], errors: [] });
    expect(queries).toHaveLength(2);
    expect(queries.every((q) => q.includes("repo:acme/api") && !q.includes("undefined"))).toBe(
      true,
    );
  });
});

describe("platform", () => {
  const win = configSchema("win32");
  const winTerminals = {
    shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    bins: {
      claude: "C:\\Users\\me\\.local\\bin\\claude.exe",
      codex: "C:\\Users\\me\\.local\\bin\\codex.exe",
      grok: "C:\\Users\\me\\.local\\bin\\grok.exe",
    },
  };

  test("macOS fills the binaries in; other platforms must set them", () => {
    const mac = configSchema("darwin").parse({});
    expect(mac.terminals.shell).toBe("/bin/zsh");
    expect(mac.github.bin).toBe("/opt/homebrew/bin/gh");
    expect(configSchema("linux").safeParse({ providers: { github: false } }).success).toBe(false);
    expect(win.safeParse({ providers: { github: false } }).success).toBe(false);
  });

  test("Windows takes drive-letter paths only, and needs gh only with GitHub on", () => {
    expect(win.safeParse({ terminals: winTerminals, providers: { github: false } }).success).toBe(
      true,
    );
    expect(win.safeParse({ terminals: winTerminals }).success).toBe(false);
    for (const shell of ["/bin/zsh", "\\Windows\\pwsh.exe", "\\\\host\\share\\pwsh.exe"]) {
      const terminals = { ...winTerminals, shell };
      expect(win.safeParse({ terminals, providers: { github: false } }).success).toBe(false);
    }
  });

  test("every binary must exist; Windows accepts .exe only", () => {
    const mac = configSchema("darwin").parse({
      envs: { bin: "/opt/env", root: "/tmp", repos: ["api"] },
    });
    const missing = checkBins(mac, "darwin", (p) => p !== "/opt/env");
    expect(missing).toEqual(["envs.bin: /opt/env does not exist"]);
    expect(checkBins(mac, "darwin", () => true)).toEqual([]);

    const terminals = {
      shell: "C:\\tools\\shell.CMD",
      bins: { claude: "C:\\b\\claude.EXE", codex: "C:\\b\\codex.bat", grok: "C:\\b\\grok.ps1" },
    };
    const config = win.parse({ terminals, providers: { github: false } });
    expect(checkBins(config, "win32", () => true)).toEqual([
      "terminals.shell: C:\\tools\\shell.CMD is not an .exe",
      "terminals.bins.codex: C:\\b\\codex.bat is not an .exe",
      "terminals.bins.grok: C:\\b\\grok.ps1 is not an .exe",
    ]);
  });

  test("gh is not checked while GitHub is off", () => {
    const config = configSchema("darwin").parse({ providers: { github: false } });
    expect(checkBins(config, "darwin", (p) => !p.endsWith("/gh"))).toEqual([]);
  });
});

describe("personal profile", () => {
  const config = ConfigSchema.parse({
    port: 4317,
    providers: { github: false },
    repos: [local],
    terminals: { shell: "/bin/sh" },
  });
  const db = openDb(":memory:");
  const terminals = new TerminalManager(config, db, () => Promise.resolve({}));
  const app = createApp({ config, db, terminals, tokens: new AttachTokens() });
  const request = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("disabled providers answer 200 with { disabled: true }", async () => {
    for (const path of ["/api/tickets", "/api/tickets/ABC-1", "/api/github/prs"]) {
      const res = await request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ disabled: true });
    }
  });

  test("a PR review cannot start from a repo GitHub does not read", async () => {
    const res = await request("/api/terminals", {
      harness: "claude",
      location: "app",
      cols: 80,
      rows: 24,
      review: { repo: "notes", number: 1 },
    });
    expect(res.status).toBe(400);
    expect(terminals.list()).toHaveLength(0);
  });
});
