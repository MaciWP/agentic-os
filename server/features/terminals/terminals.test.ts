import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import headlessPkg from "@xterm/headless";
import { run } from "../../../scripts/aos.ts";
import { envFor } from "../../../shared/harness-capabilities.ts";
import { clampSize } from "../../../shared/terminals.ts";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { until } from "../../test-wait.ts";
import { cleanEnv, loginEnvLoader, parseEnvDump } from "./env.ts";
import { argvFor, LaunchError, resolveLocation, terminalEnv } from "./harness.ts";
import {
  type Client,
  KILL_AFTER_MS,
  MAX_CLIENT_BUFFER,
  MAX_RUNNING,
  TerminalManager,
} from "./pty.ts";
import { Screen, type Snapshot } from "./screen.ts";
import { completeLength, Splitter } from "./splitter.ts";
import { AttachTokens, allowedOrigins, TOKEN_TTL_MS } from "./ws-guard.ts";

const { Terminal } = headlessPkg as unknown as typeof import("@xterm/headless");
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("PTY environment", () => {
  test("strips agent-session variables and sets the terminal type", () => {
    const env = cleanEnv(
      {
        PATH: "/x",
        CLAUDECODE: "1",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_PID: "9",
        ORCA_AGENT_HOOK_TOKEN: "t",
        AGENTIC_OS_DATA: "/d",
        AOS_AGENT_ID: "parent-agent",
        AOS_URL: "http://localhost:9999",
        LANG: "C",
      },
      { SSH_AUTH_SOCK: "/sock", CLAUDE_CODE_SESSION_ID: "s" },
    );
    expect(Object.keys(env).sort()).toEqual(["COLORTERM", "LANG", "PATH", "SSH_AUTH_SOCK", "TERM"]);
    expect(env.TERM).toBe("xterm-256color");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  test("reads only what follows the marker, so rc-file noise is ignored", () => {
    const dump = `banner\0__AOS_ENV__\0A=1\0B=x=y\0`;
    expect(parseEnvDump(dump)).toEqual({ A: "1", B: "x=y" });
    expect(() => parseEnvDump("no marker")).toThrow();
  });
});

describe("login environment loader", () => {
  test("a failed read is forgotten and tried again; a good one is kept; callers share a read", async () => {
    const reads: string[] = [];
    let fail = true;
    const load = loginEnvLoader(async () => {
      reads.push(fail ? "fail" : "ok");
      if (fail) throw new Error(".zshrc too slow");
      return { PATH: "/bin" };
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const [a, b] = [load(), load()];
      expect(a).toBe(b);
      await expect(a).rejects.toThrow(".zshrc too slow");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        'ERROR terminals: login environment unavailable err=".zshrc too slow"',
      );
      fail = false;
      expect(await load()).toEqual({ PATH: "/bin" });
      fail = true;
      expect(await load()).toEqual({ PATH: "/bin" });
      expect(reads).toEqual(["fail", "ok"]);
    } finally {
      console.error = original;
    }
  });
});

describe("Splitter", () => {
  test("holds a split CSI until it completes", () => {
    const s = new Splitter();
    expect(text(s.push(bytes("a\x1b[")))).toBe("a");
    expect(s.pending).toBe(true);
    expect(text(s.push(bytes("31mX")))).toBe("\x1b[31mX");
    expect(s.pending).toBe(false);
  });

  test("holds a split multibyte character", () => {
    const s = new Splitter();
    const euro = bytes("€");
    expect(text(s.push(new Uint8Array([0x41, ...euro.slice(0, 2)])))).toBe("A");
    expect(text(s.push(euro.slice(2)))).toBe("€");
  });

  test("holds an OSC until BEL and passes complete sequences through", () => {
    expect(completeLength(bytes("\x1b]0;title"))).toBe(0);
    expect(completeLength(bytes("\x1b]0;title\x07ok"))).toBe(12);
    expect(completeLength(bytes("\x1b]0;t\x1b\\"))).toBe(7);
    expect(completeLength(bytes("x\x1b(B"))).toBe(4);
    expect(completeLength(bytes("x\x1b("))).toBe(1);
    expect(completeLength(bytes("\x1b"))).toBe(0);
  });

  test("a CSI ends only on a final byte or CAN/SUB; a BEL inside it does not end it", () => {
    const s = new Splitter();
    expect(text(s.push(bytes("a\x1b[31\x07")))).toBe("a");
    expect(s.pending).toBe(true);
    expect(text(s.push(bytes("mX")))).toBe("\x1b[31\x07mX");
    expect(completeLength(bytes("\x1b[31\x18"))).toBe(5);
    expect(completeLength(bytes("\x1b[?25"))).toBe(0);
  });

  test("a snapshot taken mid-sequence stays clean thanks to the splitter", async () => {
    const screen = new Screen(
      40,
      5,
      () => {},
      () => {},
    );
    const s = new Splitter();
    screen.write(s.push(bytes("a\x1b[")));
    const snap = await new Promise<Snapshot>((r) => screen.attach(r));
    const replica = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    await new Promise<void>((r) => replica.write(snap.data, r));
    await new Promise<void>((r) => replica.write(s.push(bytes("31mX")), r));
    expect(replica.buffer.active.getLine(0)?.translateToString(true)).toBe("aX");
    expect(replica.buffer.active.getLine(0)?.getCell(1)?.getFgColor()).toBe(1);
  });
});

describe("Screen", () => {
  // 3000 lines through two screens: 4.6 s at load 4, at the edge of the 5 s default.
  test("snapshot + live output after it rebuild the same screen, with no gaps or duplicates", async () => {
    const live: Uint8Array[] = [];
    let attached = false;
    const screen = new Screen(
      60,
      10,
      (b) => attached && live.push(b),
      () => {},
    );
    for (let i = 0; i < 3000; i++) screen.write(bytes(`line ${i} \x1b[3${i % 8}mcolor\x1b[0m\r\n`));
    const first = new Promise<Snapshot>((r) =>
      screen.attach((snap) => {
        attached = true;
        r(snap);
      }),
    );
    for (let i = 3000; i < 6500; i++) screen.write(bytes(`line ${i}\r\n`));
    const final = await new Promise<Snapshot>((r) => screen.attach(r));
    const snap = await first;

    const replica = new Terminal({
      cols: snap.cols,
      rows: snap.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    await new Promise<void>((r) => replica.write(snap.data, r));
    for (const b of live) await new Promise<void>((r) => replica.write(b, r));
    const lines = (t: InstanceType<typeof Terminal>) => {
      const out: string[] = [];
      for (let i = 0; i < t.buffer.active.length; i++) {
        out.push(t.buffer.active.getLine(i)?.translateToString(true) ?? "");
      }
      return out.join("\n").trimEnd();
    };
    const server = new Terminal({
      cols: final.cols,
      rows: final.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    await new Promise<void>((r) => server.write(final.data, r));
    expect(lines(replica)).toBe(lines(server));
    expect(lines(replica).match(/line 4500\n/g)?.length).toBe(1);
  }, 20_000);

  test("an emoji takes two cells, so a TUI's jump to a column lands where it counted", async () => {
    const screen = new Screen(
      20,
      3,
      () => {},
      () => {},
    );
    // Claude counts 🟢 as two cells: "a" sits in column 3, and CHA 3 overwrites it.
    screen.write(bytes("🟢ab\x1b[3GX"));
    const text = await new Promise<string>((r) => screen.text(3, r));
    expect(text.split("\n")[0]).toBe("🟢Xb");
  });

  test("a snapshot restores the scroll region and a hidden cursor", async () => {
    const screen = new Screen(
      20,
      10,
      () => {},
      () => {},
    );
    const setup = "top\r\n\x1b[8;1Hbottom\x1b[3;6r\x1b[6;1HA\x1b[?25l";
    screen.write(bytes(setup));
    const snap = await new Promise<Snapshot>((r) => screen.attach(r));
    expect(snap.data.endsWith("\x1b[?25l")).toBe(true);
    // The same later output must land in the same place on the server and on the replica.
    const after = "\r\nB\r\nC\r\nD\r\nE";
    screen.write(bytes(after));
    const final = await new Promise<Snapshot>((r) => screen.attach(r));
    const replica = new Terminal({ cols: 20, rows: 10, allowProposedApi: true });
    await new Promise<void>((r) => replica.write(snap.data, r));
    await new Promise<void>((r) => replica.write(after, r));
    const expected = new Terminal({ cols: 20, rows: 10, allowProposedApi: true });
    await new Promise<void>((r) => expected.write(final.data, r));
    const rows = (t: InstanceType<typeof Terminal>) =>
      Array.from({ length: 10 }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true));
    expect(rows(replica)).toEqual(rows(expected));
    expect(rows(replica)[7]).toBe("bottom");
    expect(rows(replica)[5]).toBe("E");
  });

  test("origin mode with the full scroll region restores the cursor before further output", async () => {
    const screen = new Screen(
      40,
      12,
      () => {},
      () => {},
    );
    const reference = new Terminal({ cols: 40, rows: 12, allowProposedApi: true });
    const replica = new Terminal({ cols: 40, rows: 12, allowProposedApi: true });
    try {
      const setup = "\x1b[?6h\x1b[5;7HHELLO";
      screen.write(bytes(setup));
      await new Promise<void>((r) => reference.write(setup, r));
      const snap = await new Promise<Snapshot>((r) => screen.attach(r));
      await new Promise<void>((r) => replica.write(snap.data, r));
      expect(replica.buffer.active.cursorY).toBe(reference.buffer.active.cursorY);
      expect(replica.buffer.active.cursorX).toBe(reference.buffer.active.cursorX);
      await new Promise<void>((r) => reference.write("NEXT", r));
      await new Promise<void>((r) => replica.write("NEXT", r));
      for (let i = 0; i < 12; i++)
        expect(replica.buffer.active.getLine(i)?.translateToString()).toBe(
          reference.buffer.active.getLine(i)?.translateToString(),
        );
    } finally {
      screen.dispose();
      reference.dispose();
      replica.dispose();
    }
  });

  test("an overflow reset waits for the write being parsed, so old output never returns", async () => {
    const screen = new Screen(
      40,
      5,
      () => {},
      () => {},
    );
    const big = new Uint8Array(9 * 1024 * 1024).fill(0x41);
    screen.write(bytes("OLDMARK"));
    screen.write(big);
    screen.write(big);
    screen.write(bytes("\r\nNEW"));
    const snap = await new Promise<Snapshot>((r) => screen.attach(r));
    expect(snap.data).toContain("NEW");
    expect(snap.data).not.toContain("OLDMARK");
    // The byte count stays honest: drained writes afterwards do not overflow again.
    let again = 0;
    const second = new Screen(
      40,
      5,
      () => {},
      () => again++,
    );
    second.write(bytes("x"));
    second.write(big);
    second.write(big);
    await new Promise<Snapshot>((r) => second.attach(r));
    for (let i = 0; i < 20; i++) {
      second.write(new Uint8Array(1024 * 1024).fill(0x42));
      await new Promise<Snapshot>((r) => second.attach(r));
    }
    expect(again).toBe(1);
  });

  test("sizes are clamped the same way on both ends", () => {
    expect(clampSize(5, 1000)).toEqual({ cols: 20, rows: 200 });
    expect(clampSize(120.4, 32.6)).toEqual({ cols: 120, rows: 33 });
  });

  test("a backlog above the cap resets the screen and reports the overflow", () => {
    let overflowed = 0;
    const screen = new Screen(
      20,
      5,
      () => {},
      () => overflowed++,
    );
    const big = new Uint8Array(9 * 1024 * 1024).fill(0x41);
    screen.write(big);
    screen.write(big);
    expect(overflowed).toBe(1);
  });

  test("text is what the screen shows, wrapped lines joined, after every write before it", async () => {
    const screen = new Screen(
      10,
      4,
      () => {},
      () => {},
    );
    expect(screen.seq).toBe(0);
    screen.write(bytes("one\r\n\x1b[31mtwo\x1b[0m\r\n"));
    screen.write(bytes("abcdefghijKLMNO\r\nlast"));
    expect(screen.seq).toBe(40);
    const all = await new Promise<string>((r) => screen.text(100, r));
    expect(all).toBe("one\ntwo\nabcdefghijKLMNO\nlast");
    expect(await new Promise<string>((r) => screen.text(2, r))).toBe("abcdefghijKLMNO\nlast");
    expect(screen.bracketedPaste).toBe(false);
    screen.write(bytes("\x1b[?2004h"));
    await new Promise<string>((r) => screen.text(1, r));
    expect(screen.bracketedPaste).toBe(true);
  });
});

describe("local model terminals", () => {
  const hub = ConfigSchema.parse({ ai: { machine: "win" } });
  test("a Claude on model `local` goes to the GPU machine through this server", () => {
    const env = terminalEnv("claude", hub, "local");
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4317/api/machines/win/ai",
      ANTHROPIC_AUTH_TOKEN: "local",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "local",
      ANTHROPIC_CUSTOM_HEADERS: "Origin: http://127.0.0.1:4317",
      CLAUDE_CODE_SCROLL_SPEED: "6",
    });
    const worker = ConfigSchema.parse({
      port: 4319,
      ai: { engine: { bin: "/opt/llama-server", model: "/m/q.gguf" } },
    });
    expect(terminalEnv("claude", worker, "local").ANTHROPIC_BASE_URL).toBe(
      "http://127.0.0.1:4319/api/ai",
    );
  });
  test("any other terminal gets no Anthropic variables", () => {
    for (const env of [
      terminalEnv("claude", hub, "opus"),
      terminalEnv("claude", hub),
      terminalEnv("codex", hub, "local"),
      terminalEnv("shell", hub),
    ])
      expect(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);
  });
  test("refuses where no local model is configured, another harness, or an effort", () => {
    expect(() => terminalEnv("claude", ConfigSchema.parse({}), "local")).toThrow(LaunchError);
    expect(() => argvFor("codex", hub, { model: "local" })).toThrow(LaunchError);
    expect(() => argvFor("claude", hub, { model: "local", effort: "high" })).toThrow(LaunchError);
    expect(argvFor("claude", hub, { model: "local" }).slice(-2)).toEqual(["--model", "local"]);
  });
});

describe("harness argv", () => {
  const config = ConfigSchema.parse({});
  const { bins } = config.terminals;
  const codexBypass = ["--dangerously-bypass-approvals-and-sandbox", "--no-alt-screen"];
  const grokBypass = ["--always-approve", "--no-plan", "--no-alt-screen"];
  test("maps ids to absolute binaries and passes the prompt as one element", () => {
    expect(argvFor("shell", config)).toEqual(["/bin/zsh", "-l"]);
    expect(argvFor("claude", config, { prompt: "Ticket X; rm -rf /" })).toEqual([
      bins.claude,
      "--dangerously-skip-permissions",
      "Ticket X; rm -rf /",
    ]);
  });
  test("every agent launch bypasses permissions, with or without a prompt", () => {
    expect(argvFor("claude", config)).toEqual([bins.claude, "--dangerously-skip-permissions"]);
    expect(argvFor("codex", config)).toEqual([bins.codex, ...codexBypass]);
    expect(argvFor("grok", config)).toEqual([bins.grok, ...grokBypass]);
    expect(argvFor("codex", config, { prompt: "P" })).toEqual([bins.codex, ...codexBypass, "P"]);
    expect(argvFor("grok", config, { prompt: "P" })).toEqual([bins.grok, ...grokBypass, "P"]);
  });
  test("plan mode replaces bypass with bypass one approval away, for a new Claude only", () => {
    expect(argvFor("claude", config, { plan: true, prompt: "P" })).toEqual([
      bins.claude,
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "plan",
      "P",
    ]);
    const sid = "01a0fc0a-51bb-7231-a049-511e3414d05a";
    expect(() => argvFor("codex", config, { plan: true })).toThrow(LaunchError);
    expect(() => argvFor("shell", config, { plan: true })).toThrow(LaunchError);
    expect(() => argvFor("claude", config, { plan: true, resume: sid })).toThrow(LaunchError);
  });
  test("Claude gets a faster wheel; the variable survives cleanEnv by going in afterwards", () => {
    expect(envFor("claude")).toEqual({ CLAUDE_CODE_SCROLL_SPEED: "6" });
    expect(envFor("codex")).toEqual({});
    expect(envFor("shell")).toEqual({});
  });
  test("model and effort become each CLI's own flags, before the prompt", () => {
    expect(argvFor("claude", config, { model: "m-1", effort: "max", prompt: "P" })).toEqual([
      bins.claude,
      "--dangerously-skip-permissions",
      "--model",
      "m-1",
      "--effort",
      "max",
      "P",
    ]);
    expect(argvFor("codex", config, { model: "gpt-x", effort: "high" })).toEqual([
      bins.codex,
      ...codexBypass,
      "-m",
      "gpt-x",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(argvFor("grok", config, { model: "grok-x", effort: "low" })).toEqual([
      bins.grok,
      ...grokBypass,
      "-m",
      "grok-x",
      "--reasoning-effort",
      "low",
    ]);
  });
  test("rejects a model that is an option or a config key, and an effort the CLI lacks", () => {
    for (const model of ["-x", "a=b", "sandbox_mode=danger", "m".repeat(65), "", "a b"])
      expect(() => argvFor("codex", config, { model })).toThrow(LaunchError);
    expect(() => argvFor("grok", config, { effort: "max" })).toThrow(LaunchError);
    expect(() => argvFor("codex", config, { effort: "max" })).toThrow(LaunchError);
    expect(() => argvFor("claude", config, { effort: "minimal" })).toThrow(LaunchError);
  });
  test("rejects prompts that look like options, contain NUL or are too long", () => {
    expect(() => argvFor("claude", config, { prompt: "--dangerously-skip-permissions" })).toThrow(
      LaunchError,
    );
    expect(() => argvFor("codex", config, { prompt: "a\0b" })).toThrow(LaunchError);
    expect(() => argvFor("grok", config, { prompt: "x".repeat(17 * 1024) })).toThrow(LaunchError);
    expect(() => argvFor("shell", config, { prompt: "echo" })).toThrow(LaunchError);
    expect(() => argvFor("shell", config, { model: "m" })).toThrow(LaunchError);
  });
  test("a resume reopens the session with permission bypass and takes no prompt", () => {
    const sid = "01a0fc0a-51bb-7231-a049-511e3414d05a";
    expect(argvFor("claude", config, { resume: sid, model: "m" })).toEqual([
      bins.claude,
      "--dangerously-skip-permissions",
      "--resume",
      sid,
      "--model",
      "m",
    ]);
    expect(argvFor("codex", config, { resume: sid })).toEqual([
      bins.codex,
      "resume",
      sid,
      ...codexBypass,
    ]);
    expect(argvFor("grok", config, { resume: sid })).toEqual([
      bins.grok,
      ...grokBypass,
      "--resume",
      sid,
    ]);
    for (const bad of ["--fork-session", "last", `${sid} x`, ""])
      expect(() => argvFor("claude", config, { resume: bad })).toThrow(LaunchError);
    expect(() => argvFor("claude", config, { resume: sid, prompt: "P" })).toThrow(LaunchError);
    expect(() => argvFor("shell", config, { resume: sid })).toThrow(LaunchError);
  });
  test("a Codex picker is `codex resume` without an id, and only Codex has one", () => {
    const sid = "01a0fc0a-51bb-7231-a049-511e3414d05a";
    expect(argvFor("codex", config, { pick: true, model: "m" })).toEqual([
      bins.codex,
      "resume",
      ...codexBypass,
      "-m",
      "m",
    ]);
    expect(() => argvFor("claude", config, { pick: true })).toThrow(LaunchError);
    expect(() => argvFor("shell", config, { pick: true })).toThrow(LaunchError);
    expect(() => argvFor("codex", config, { pick: true, resume: sid })).toThrow(LaunchError);
    expect(() => argvFor("codex", config, { pick: true, prompt: "P" })).toThrow(LaunchError);
  });
  test("relative binaries are refused by the config", () => {
    expect(ConfigSchema.safeParse({ terminals: { bins: { claude: "claude" } } }).success).toBe(
      false,
    );
  });
  test("locations are ids resolved by the server, through symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-loc-"));
    const link = join(dir, "link");
    symlinkSync(tmpdir(), link);
    const withRepo = ConfigSchema.parse({
      repos: [{ id: "r", owner: "o", name: "n", login: "l", localPath: link }],
    });
    expect(() => resolveLocation(withRepo, "../etc")).toThrow(LaunchError);
    expect(() => resolveLocation(withRepo, "/tmp")).toThrow(LaunchError);
    expect(resolveLocation(withRepo, "repo:r").cwd).not.toContain("/link");
    rmSync(dir, { recursive: true });
  });
  test("the free folder is made on its first launch", () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-scratch-"));
    const scratch = join(dir, "free");
    const config = ConfigSchema.parse({ terminals: { scratch } });
    expect(resolveLocation(config, "scratch").cwd).toBe(realpathSync(scratch));
    expect(ConfigSchema.safeParse({ terminals: { scratch: "free" } }).success).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

describe("attach tokens", () => {
  test("are single use, bound to terminal and origin, and expire", () => {
    let now = 0;
    const tokens = new AttachTokens(() => now);
    const a = tokens.issue("t1", "http://localhost:4317");
    expect(tokens.consume(a, "t1", "http://localhost:4317")).toBe(true);
    expect(tokens.consume(a, "t1", "http://localhost:4317")).toBe(false);
    const b = tokens.issue("t1", "http://localhost:4317");
    expect(tokens.consume(b, "t2", "http://localhost:4317")).toBe(false);
    const c = tokens.issue("t1", "http://localhost:4317");
    expect(tokens.consume(c, "t1", "http://evil.test")).toBe(false);
    const d = tokens.issue("t1", "http://localhost:4317");
    now += TOKEN_TTL_MS + 1;
    expect(tokens.consume(d, "t1", "http://localhost:4317")).toBe(false);
    expect(new AttachTokens().consume(a, "t1", "http://localhost:4317")).toBe(false);
  });
  test("the dev origin is only allowed outside production", () => {
    expect(allowedOrigins(4317, 5173, true).has("http://localhost:5173")).toBe(false);
    expect(allowedOrigins(4317, 5173, false).has("http://localhost:5173")).toBe(true);
    expect(allowedOrigins(4317, 5173, true).has("http://agentic-os.localhost:4317")).toBe(true);
  });
});

// The real route on a real Bun server: the upgrade, the token and the PTY.
describe("terminal WebSocket", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let origin: string;
  let manager: TerminalManager;
  let db: ReturnType<typeof openDb>;

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port ?? 0;
    probe.stop(true);
    // A Codex that exits at once: a resume only has to start it.
    const config = ConfigSchema.parse({
      port,
      terminals: { shell: "/bin/sh", bins: { codex: "/usr/bin/true" } },
    });
    db = openDb(":memory:");
    manager = new TerminalManager(config, db, () =>
      Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {})),
    );
    const app = createApp({ config, db, terminals: manager, tokens: new AttachTokens() });
    const { websocket } = await import("hono/bun");
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket });
    base = `127.0.0.1:${port}`;
    origin = `http://${base}`;
  });
  afterAll(async () => {
    await manager.stopAll(200);
    server.stop(true);
  });

  const post = (path: string, body: unknown = {}) =>
    fetch(`http://${base}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const upgrade = (id: string, headers: Record<string, string>) =>
    fetch(`http://${base}/api/terminals/${id}/ws`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });

  type Socket = {
    ws: WebSocket;
    out: () => string;
    json: () => Record<string, unknown>[];
    closed: Promise<number>;
  };
  const open = async (id: string, token?: string, take?: boolean): Promise<Socket> => {
    const ws = new WebSocket(`ws://${base}/api/terminals/${id}/ws`, {
      headers: { origin },
    } as never);
    ws.binaryType = "arraybuffer";
    let out = "";
    const json: Record<string, unknown>[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data);
        json.push(m);
        if (m.type === "snapshot") out += m.data;
      } else out += text(new Uint8Array(e.data));
    };
    const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
    await new Promise((r) => ws.addEventListener("open", r));
    if (token) ws.send(JSON.stringify({ type: "auth", token, take }));
    return { ws, out: () => out, json: () => json, closed };
  };
  const shell = async () =>
    (
      (await (await post("/api/terminals", { harness: "shell", location: "app" })).json()) as {
        terminal: { id: string };
      }
    ).terminal.id;
  const fake = (open = true) => {
    const got: (string | Uint8Array)[] = [];
    const state = { closed: 0, buffered: 0 };
    const client: Client = {
      send: (d) => got.push(d),
      close: (code) => {
        state.closed = code;
      },
      bufferedAmount: () => state.buffered,
      isOpen: () => open && state.closed === 0,
    };
    const out = () => got.map((d) => (typeof d === "string" ? d : text(d))).join("");
    return { client, got, state, out };
  };
  const token = async (id: string) =>
    ((await (await post(`/api/terminals/${id}/attach`)).json()) as { token: string }).token;

  test("a lost agent says so on attach and «Reanudar» brings it back once", async () => {
    const insert = db.query(
      `INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at, resumes)
       VALUES (?, ?, 'app', '/x', 'lost', '2026-10-07T07:54:05Z', ?)`,
    );
    insert.run("lost-codex", "codex", 3);
    insert.run("lost-shell", "shell", 0);
    const error = async (res: Response) => [
      res.status,
      ((await res.json()) as { error: string }).error,
    ];
    expect(await error(await post("/api/terminals/lost-codex/attach"))).toEqual([404, "lost"]);
    expect(await error(await post("/api/terminals/lost-shell/attach"))).toEqual([404, "not_found"]);
    expect(await error(await post("/api/terminals/nope/attach"))).toEqual([404, "not_found"]);
    expect(await error(await post("/api/terminals/lost-shell/resume"))).toEqual([
      400,
      "launch_rejected",
    ]);
    expect(await error(await post("/api/terminals/nope/resume"))).toEqual([404, "not_found"]);
    const res = await post("/api/terminals/lost-codex/resume");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { terminal: { id: string } }).terminal.id).toBe("lost-codex");
    // A manual resume starts the crash-loop count again.
    expect(db.query("SELECT resumes FROM terminal_sessions WHERE id = 'lost-codex'").get()).toEqual(
      { resumes: 1 },
    );
    expect(await error(await post("/api/terminals/lost-codex/resume"))).toEqual([404, "not_found"]);
  });

  test("«Reiniciar» is 404 for an unknown terminal and 409 when there is no session", async () => {
    expect((await post("/api/terminals/nope/restart")).status).toBe(404);
    const { terminal } = (await (
      await post("/api/terminals", { harness: "shell", location: "app" })
    ).json()) as { terminal: { id: string } };
    const res = await post(`/api/terminals/${terminal.id}/restart`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("no_session");
    expect(
      (await (await post(`/api/terminals/${terminal.id}/attach`)).json()) as object,
    ).toHaveProperty("token");
  });

  test("the upgrade refuses a foreign, null or missing Origin and a bad Host", async () => {
    const { terminal } = (await (
      await post("/api/terminals", { harness: "shell", location: "app" })
    ).json()) as { terminal: { id: string } };
    expect((await upgrade(terminal.id, { origin: "http://evil.test" })).status).toBe(403);
    expect((await upgrade(terminal.id, { origin: "null" })).status).toBe(403);
    expect((await upgrade(terminal.id, {})).status).toBe(403);
    expect((await upgrade(terminal.id, { origin, host: "evil.test" })).status).toBe(403);
    manager.stop(terminal.id);
  });

  test("round trip, busy, takeover, and an unauthenticated socket gets nothing and displaces nobody", async () => {
    const res = await post("/api/terminals", { harness: "shell", location: "app" });
    expect(res.status).toBe(201);
    const { terminal } = (await res.json()) as { terminal: { id: string } };

    const a = await open(terminal.id, await token(terminal.id));
    await until(() => a.json().some((m) => m.type === "snapshot"));
    a.ws.send(JSON.stringify({ type: "input", data: "echo MARK_$((6*7))\r" }));
    await until(() => a.out().includes("MARK_42"));

    // No token: input is refused, the socket is closed and the owner keeps the terminal.
    const intruder = await open(terminal.id);
    intruder.ws.send(JSON.stringify({ type: "input", data: "echo PWNED\r" }));
    expect(await intruder.closed).toBe(4401);
    expect(intruder.out()).toBe("");
    const replayed = await open(terminal.id, "bogus");
    expect(await replayed.closed).toBe(4401);
    expect(manager.get(terminal.id)?.attached).toBe(true);
    a.ws.send(JSON.stringify({ type: "input", data: "echo STILL_$((1+1))\r" }));
    await until(() => a.out().includes("STILL_2"));
    expect(a.out()).not.toContain("PWNED");

    // A second window that does not take is told busy; the owner keeps the terminal.
    const asked = await open(terminal.id, await token(terminal.id));
    expect(await asked.closed).toBe(4409);
    expect(asked.json().map((m) => m.type)).toEqual(["busy"]);
    a.ws.send(JSON.stringify({ type: "input", data: "echo KEPT_$((2+2))\r" }));
    await until(() => a.out().includes("KEPT_4"));

    // One that takes it displaces the owner, and its snapshot holds the earlier output.
    const b = await open(terminal.id, await token(terminal.id), true);
    await until(() => b.json().some((m) => m.type === "snapshot"));
    expect(b.out()).toContain("MARK_42");
    expect(await a.closed).toBe(4001);
    expect(a.json().some((m) => m.type === "takeover")).toBe(true);

    b.ws.send(JSON.stringify({ type: "input", data: "exit 3\r" }));
    await until(() => b.json().some((m) => m.type === "exit"));
    expect(b.json().find((m) => m.type === "exit")).toMatchObject({ code: 3, state: "exited" });
  });

  test("an attached window's ping is answered with a pong; an unattached one is closed", async () => {
    const { terminal } = (await (
      await post("/api/terminals", { harness: "shell", location: "app" })
    ).json()) as { terminal: { id: string } };
    const s = await open(terminal.id, await token(terminal.id));
    await until(() => s.json().some((m) => m.type === "snapshot"));
    s.ws.send(JSON.stringify({ type: "ping" }));
    await until(() => s.json().some((m) => m.type === "pong"));
    // Before its token, a ping is no token: the socket is closed like any other message.
    const early = await open(terminal.id);
    early.ws.send(JSON.stringify({ type: "ping" }));
    expect(await early.closed).toBe(4401);
    expect(early.json()).toEqual([]);
    manager.stop(terminal.id);
  });

  test("a socket that never authenticates is closed after 2 s", async () => {
    const { terminal } = (await (
      await post("/api/terminals", { harness: "shell", location: "app" })
    ).json()) as { terminal: { id: string } };
    const s = await open(terminal.id);
    expect(await s.closed).toBe(4401);
    manager.stop(terminal.id);
  });

  test("Stop ends the shell and its background descendants", async () => {
    const { terminal } = (await (
      await post("/api/terminals", { harness: "shell", location: "app" })
    ).json()) as { terminal: { id: string } };
    const s = await open(terminal.id, await token(terminal.id));
    await until(() => s.json().some((m) => m.type === "snapshot"));
    s.ws.send(
      JSON.stringify({ type: "input", data: "sleep 3137 & sleep 3138 & echo BG_$((2+2))\r" }),
    );
    await until(() => s.out().includes("BG_4"));
    const alive = () => Bun.spawnSync(["pgrep", "-f", "sleep 313[78]"]).stdout.toString().trim();
    expect(alive()).not.toBe("");
    expect(
      ((await (await post(`/api/terminals/${terminal.id}/stop`)).json()) as { stopping: boolean })
        .stopping,
    ).toBe(true);
    await until(() => manager.get(terminal.id)?.state === "exited", 7000);
    await until(() => alive() === "", 7000);
  }, 10_000);

  // The SIGKILL comes KILL_AFTER_MS after the stop. A fixed 7 s left 2 s for that timer and
  // pgrep, and ran out in the full check at load 30 (7.1 s); alone it takes 5.5 s.
  test(
    "Stop still kills descendants that ignore SIGHUP after the shell itself has exited",
    async () => {
      const id = await shell();
      const s = await open(id, await token(id));
      await until(() => s.json().some((m) => m.type === "snapshot"));
      s.ws.send(
        JSON.stringify({
          type: "input",
          data: "set +m; (trap '' HUP; exec sleep 3139) & echo HUP_$((3+3))\r",
        }),
      );
      await until(() => s.out().includes("HUP_6"));
      const alive = () => Bun.spawnSync(["pgrep", "-f", "sleep 3139"]).stdout.toString().trim();
      // The echo runs as soon as the subshell forks, before it sets its trap. Under load a stop
      // sent then kills the subshell by SIGHUP, and the check below fails with no defect behind it
      // (full check, load 66: the sleep gone at 2.8 s). Stop once the sleep itself runs.
      await until(() => alive() !== "");
      manager.stop(id);
      await until(() => manager.get(id)?.state === "exited", 3000);
      expect(alive()).not.toBe("");
      await until(() => alive() === "", KILL_AFTER_MS + 5000);
    },
    KILL_AFTER_MS + 15_000,
  );

  test("the exit notice comes after the last output", async () => {
    const id = await shell();
    const s = await open(id, await token(id));
    await until(() => s.json().some((m) => m.type === "snapshot"));
    let atExit = "";
    s.ws.addEventListener("message", (e) => {
      if (typeof e.data === "string" && JSON.parse(e.data).type === "exit") atExit = s.out();
    });
    s.ws.send(JSON.stringify({ type: "input", data: "seq 1 40000; exit 3\r" }));
    await until(() => atExit !== "", 8000);
    expect(atExit).toContain("\n40000");
  }, 10_000);

  test("a closed holder does not make the next window busy", async () => {
    const id = await shell();
    const a = fake();
    manager.attach(id, a.client);
    await until(() => a.got.length > 0);
    // Its socket is gone but the detach has not arrived yet: a retry still gets the terminal.
    a.state.closed = 1006;
    const retry = fake();
    manager.attach(id, retry.client);
    await until(() => retry.out().length > 0);
    expect(retry.state.closed).toBe(0);
    expect(retry.out()).not.toContain('"busy"');
    manager.stop(id);
  });

  test("a window that closed while its attach was queued displaces nobody", async () => {
    const id = await shell();
    const a = fake();
    manager.attach(id, a.client);
    await until(() => a.got.length > 0);
    // It asked to take: only the queued-close check keeps it from displacing the holder.
    const gone = fake(false);
    manager.attach(id, gone.client, true);
    manager.input(id, a.client, "echo KEPT_$((5+5))\r");
    await until(() => a.out().includes("KEPT_10"));
    expect(a.state.closed).toBe(0);
    expect(gone.got.length).toBe(0);
    manager.stop(id);
  });

  test("the snapshot does not count against the live output limit", async () => {
    const id = await shell();
    const c = fake();
    manager.attach(id, c.client);
    await until(() => c.got.length > 0);
    c.state.buffered = MAX_CLIENT_BUFFER + Buffer.byteLength(c.got[0] as string) - 1;
    manager.input(id, c.client, "echo ALLOWED\r");
    await until(() => c.out().includes("ALLOWED"));
    expect(c.state.closed).toBe(0);
    manager.stop(id);
  });

  test("concurrent launches cannot pass the running limit", async () => {
    let release = (_: Record<string, string>) => {};
    const env = new Promise<Record<string, string>>((r) => {
      release = r;
    });
    const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
    const capped = new TerminalManager(config, openDb(":memory:"), () => env);
    const launches = Array.from({ length: MAX_RUNNING + 1 }, () =>
      capped.create({ harness: "shell", location: "app" }),
    );
    release(cleanEnv({ PATH: "/usr/bin:/bin" }, {}));
    const results = await Promise.allSettled(launches);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(MAX_RUNNING);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
    await capped.stopAll(200);
  });

  test("unknown harnesses and locations are rejected before anything runs", async () => {
    expect((await post("/api/terminals", { harness: "bash -c id", location: "app" })).status).toBe(
      400,
    );
    expect((await post("/api/terminals", { harness: "shell", location: "/etc" })).status).toBe(400);
    // A free prompt is for agents only, and never together with a server-built one.
    expect(
      (await post("/api/terminals", { harness: "shell", location: "app", prompt: "x" })).status,
    ).toBe(400);
    expect(
      (await post("/api/terminals", { harness: "shell", location: "app", model: "x" })).status,
    ).toBe(400);
    const both = { harness: "claude", location: "app", prompt: "x", savedPrompt: "p" };
    expect((await post("/api/terminals", both)).status).toBe(400);
    const flag = { harness: "claude", location: "app", model: "--dangerously-skip-permissions" };
    expect((await post("/api/terminals", flag)).status).toBe(400);
  });

  test("a refused launch replays its refusal, never an uncertain one", async () => {
    const body = { harness: "shell", location: "missing-location", requestId: crypto.randomUUID() };
    const first = await post("/api/terminals", body);
    expect(first.status).toBe(400);
    const reason = ((await first.json()) as { detail: string }).detail;
    const again = await post("/api/terminals", body);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "launch_rejected", detail: reason });
    expect(manager.launchStatus(body.requestId)).toMatchObject({
      state: "rejected",
      error: reason,
    });
  });

  test("an agent reads, types and waits while the window stays attached", async () => {
    const id = await shell();
    const window = await open(id, await token(id));
    await until(() => window.json().some((m) => m.type === "snapshot"));
    // The shell's prompt first: seq counts output, and /send answers the seq before its write.
    await until(() => window.out().length > 0);
    const sent = await post(`/api/terminals/${id}/send`, {
      text: "echo AOS_$((6*7))",
      enter: true,
    });
    const { seq: before } = (await sent.json()) as { seq: number };
    expect(before).toBeGreaterThan(0);
    const idle = (await (
      await post(`/api/terminals/${id}/wait`, { after: before, quietMs: 300, timeoutMs: 5000 })
    ).json()) as { reason: string; seq: number };
    expect(idle.reason).toBe("idle");
    const read = (await (
      await fetch(`http://${base}/api/terminals/${id}/text?lines=5`)
    ).json()) as {
      text: string;
      seq: number;
      state: string;
    };
    expect(read.text).toContain("AOS_42");
    expect(read).toMatchObject({ seq: idle.seq, state: "running" });
    expect(window.out()).toContain("AOS_42");

    // Nothing new since `after`: the wait runs out instead of reporting old output as idle.
    const quiet = (await (
      await post(`/api/terminals/${id}/wait`, { after: read.seq, quietMs: 100, timeoutMs: 400 })
    ).json()) as { reason: string };
    expect(quiet.reason).toBe("timeout");

    // The window was never displaced and still types.
    expect(manager.get(id)?.attached).toBe(true);
    window.ws.send(JSON.stringify({ type: "input", data: "echo WIN_$((1+1))\r" }));
    await until(() => window.out().includes("WIN_2"));

    // A program that did not ask for bracketed paste gets no strict paste: typed bare, each
    // line of it would run.
    const seqBefore = (await manager.read(id, 1))?.seq ?? 0;
    expect(manager.write(id, "echo STRICT_$((2+3))\necho X", { paste: "only" })).toBe(false);
    await Bun.sleep(200);
    expect((await manager.read(id, 1))?.seq).toBe(seqBefore);
    expect(window.out()).not.toContain("STRICT_5");

    // The program asked for bracketed paste: text arrives wrapped, its own end marker removed.
    await post(`/api/terminals/${id}/send`, {
      text: "printf '\\033[?2004h'; stty -icanon; cat -v",
      enter: true,
    });
    await post(`/api/terminals/${id}/wait`, { quietMs: 300, timeoutMs: 5000 });
    await post(`/api/terminals/${id}/send`, { text: "a\x1b[201~b" });
    await until(() => window.out().includes("^[[200~ab^[[201~"));
    // One that only appears once another is removed is removed too.
    await post(`/api/terminals/${id}/send`, { text: "x\x1b[20\x1b[201~1~y" });
    await until(() => window.out().includes("^[[200~xy^[[201~"));
    expect(manager.write(id, "c\nd", { paste: "only" })).toBe(true);
    await until(() => window.out().includes("^[[200~c"));

    // Named keys go in bare, as their bytes; a name off the list is refused.
    await post(`/api/terminals/${id}/send`, { keys: ["up", "shift-tab", "esc"] });
    await until(() => window.out().includes("^[[A^[[Z^["));
    const free = await post(`/api/terminals/${id}/send`, { keys: ["\x1b[2J"] });
    expect(free.status).toBe(400);

    const ended = post(`/api/terminals/${id}/wait`, { timeoutMs: 5000 });
    manager.stop(id);
    expect(((await (await ended).json()) as { reason: string }).reason).toBe("exit");
    expect((await post(`/api/terminals/${id}/send`, { enter: true })).status).toBe(409);
  });

  // Real pauses and waits: 3.4 s at load 4, close to the 5 s default.
  test("quiet is not done: a pause reads as idle, and aos wait --until waits through it", async () => {
    const id = await shell();
    // The answer comes after a quiet second; 42done is not in the typed text.
    const command = "sleep 1; echo $((40+2))done";
    const { seq } = (await (
      await post(`/api/terminals/${id}/send`, { text: command, enter: true })
    ).json()) as { seq: number };
    const early = (await (
      await post(`/api/terminals/${id}/wait`, { after: seq, quietMs: 300, timeoutMs: 5000 })
    ).json()) as { reason: string };
    expect(early.reason).toBe("idle");
    const text = async () =>
      ((await (await fetch(`http://${base}/api/terminals/${id}/text`)).json()) as { text: string })
        .text;
    expect(await text()).not.toContain("42done");

    const out: string[] = [];
    const io = {
      out: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
      readFile: () => "",
    };
    const args = ["wait", id, "--after", String(seq), "--quiet-ms", "300", "--timeout-ms", "8000"];
    expect(await run([...args, "--until", "42done"], { AOS_URL: origin }, io)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ found: true });
    expect(await text()).toContain("42done");

    // The ADR 0004 recipe: a fresh tag per command, split in the typed line so only the
    // output line matches, whatever the exit status and whatever came before on the screen.
    const marked = async (command: string, tag: string) => {
      const sent = await post(`/api/terminals/${id}/send`, {
        text: `${command}; echo AOS_""DONE_${tag} $?`,
        enter: true,
      });
      const { seq: after } = (await sent.json()) as { seq: number };
      const started = Date.now();
      const wait = ["wait", id, "--after", String(after), "--quiet-ms", "300"];
      const code = await run([...wait, "--until", `AOS_DONE_${tag}`], { AOS_URL: origin }, io);
      return { code, ms: Date.now() - started };
    };
    expect((await marked("true", "a1")).code).toBe(0);
    const failing = await marked("sleep 1; false", "b2");
    expect(failing.code).toBe(0);
    expect(failing.ms).toBeGreaterThan(900);
    expect(await text()).toContain("AOS_DONE_b2 1");
    manager.stop(id);
  }, 20_000);

  test("the agent routes refuse a missing Origin, bad bodies and unknown ids", async () => {
    const id = await shell();
    const bare = await fetch(`http://${base}/api/terminals/${id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "echo HIDDEN", enter: true }),
    });
    expect(bare.status).toBe(403);
    const bareWait = await fetch(`http://${base}/api/terminals/${id}/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bareWait.status).toBe(403);
    expect((await fetch(`http://${base}/api/terminals/${id}/text`)).status).toBe(200);
    expect((await fetch(`http://${base}/api/terminals/${id}/text?lines=0`)).status).toBe(400);
    expect((await post(`/api/terminals/${id}/send`, {})).status).toBe(400);
    expect((await post(`/api/terminals/${id}/send`, { text: "a\0b" })).status).toBe(400);
    expect((await post(`/api/terminals/${id}/send`, { text: "é".repeat(8193) })).status).toBe(400);
    expect((await post(`/api/terminals/${id}/wait`, { timeoutMs: 100_001 })).status).toBe(400);
    expect((await post(`/api/terminals/${id}/wait`, { after: -1 })).status).toBe(400);
    expect((await fetch(`http://${base}/api/terminals/nope/text`)).status).toBe(404);
    expect((await post("/api/terminals/nope/send", { enter: true })).status).toBe(404);
    expect((await post("/api/terminals/nope/wait", {})).status).toBe(404);
    manager.stop(id);
  });

  test("a client with too much live output buffered is dropped, and can reattach", async () => {
    const { terminal } = (await (
      await post("/api/terminals", { harness: "shell", location: "app" })
    ).json()) as { terminal: { id: string } };
    const got: (string | Uint8Array)[] = [];
    let closed = 0;
    let buffered = 0;
    const slow = {
      send: (d: string | Uint8Array) => got.push(d),
      close: (code: number) => {
        closed = code;
      },
      bufferedAmount: () => buffered,
      isOpen: () => closed === 0,
    };
    manager.attach(terminal.id, slow);
    await until(() => got.length > 0);
    buffered = 5 * 1024 * 1024;
    manager.input(terminal.id, slow, "echo FLOOD\r");
    await until(() => closed === 4003);
    expect(got.some((d) => typeof d === "string" && d.includes('"slow"'))).toBe(true);
    expect(manager.get(terminal.id)?.attached).toBe(false);

    const fresh = await open(terminal.id, await token(terminal.id));
    await until(() => fresh.out().includes("FLOOD"));
    manager.stop(terminal.id);
  });
});
