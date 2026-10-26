import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsultationInput } from "../../../shared/coordination.ts";
import { KICKOFF_PERMISSION, PERMISSIONS } from "../../../shared/harness-capabilities.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { argvFor, LaunchError } from "../terminals/harness.ts";
import { capabilities, consultationArgs, executor } from "./adapters.ts";
import { newAttempt } from "./runner.ts";
import { CoordinationStore } from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-adapter-test-"));
const fake = join(dir, "fixture-cli");
writeFileSync(
  fake,
  `#!${process.execPath}\nif (process.argv.includes('--help')) { console.log('--restricted --strict-mcp-config --tools --setting-sources --disable-slash-commands --output-format --max-budget-usd'); } else if (process.argv.includes('env')) { console.log(JSON.stringify({type:'result',subtype:'success',result:Object.keys(process.env).sort().join(' '),is_error:false})); } else if (process.argv.includes('hang')) { Bun.write('hang.started', ''); setInterval(() => {}, 1000); } else { console.log(JSON.stringify({type:'result',subtype:'success',result:'Complete opinion',is_error:false})); console.error('diagnostic'); if (process.argv.includes('fail')) process.exitCode=1; }\n`,
);
chmodSync(fake, 0o700);
mkdirSync(join(dir, "snapshot"));
// A fixture that never ends is always cancelled, even when its test timed out first: one left
// running keeps `bun test` from ever exiting.
const cancels: AbortController[] = [];
afterAll(() => {
  for (const c of cancels) c.abort();
  rmSync(dir, { recursive: true, force: true });
});
test("pipe executor stores raw output, rejects failed exits and kills a cancelled fixture process", async () => {
  const config = ConfigSchema.parse({ terminals: { bins: { claude: fake } } });
  const store = new CoordinationStore(openDb(":memory:"));
  const input = ConsultationInput.parse({
    requestId: "fixture",
    location: "x",
    prompt: "Inspect code",
    participants: [
      { harness: "claude", model: "test" },
      { harness: "codex", model: "test" },
    ],
  });
  const q = {
    ...store.createConsultation("user", input, dir, ""),
    snapshot: join(dir, "snapshot"),
  };
  const exec = executor(
    () => config,
    async () => ({ PATH: "/usr/bin:/bin" }),
  );
  const a = newAttempt({ harness: "claude", model: "test" });
  expect((await exec(q, a, new AbortController().signal)).result).toBe("Complete opinion");
  expect(readFileSync(join(dir, `${a.id}.stdout`), "utf8")).toContain('"type":"result"');
  expect(readFileSync(join(dir, `${a.id}.stderr`), "utf8")).toContain("diagnostic");
  await expect(
    exec(q, newAttempt({ harness: "claude", model: "fail" }), new AbortController().signal),
  ).rejects.toThrow("code 1");
  const cancel = new AbortController();
  cancels.push(cancel);
  const pending = exec(q, newAttempt({ harness: "claude", model: "hang" }), cancel.signal);
  // Cancelled once the fixture runs, not during the capability probe before it: under load
  // that probe alone outlasts any fixed delay.
  const started = join(dir, "snapshot", "hang.started");
  try {
    for (let i = 0; i < 1000 && !existsSync(started); i++) await Bun.sleep(20);
  } finally {
    cancel.abort();
  }
  await expect(pending).rejects.toThrow("aborted");
}, 60_000);

test("losing the host lease stops the headless process group", async () => {
  const { WORKER_ENTRY } = await import("./worker.ts");
  const pidFile = join(dir, "child.pid");
  const p = Bun.spawn(
    [
      process.execPath,
      WORKER_ENTRY,
      process.execPath,
      "-e",
      `require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`,
      pidFile,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true },
  );
  let pid = 0;
  try {
    const end = Date.now() + 20_000;
    while (!Bun.file(pidFile).size && Date.now() < end) await Bun.sleep(10);
    pid = Number(await Bun.file(pidFile).text());
    p.stdin.end();
    await Promise.race([p.exited, Bun.sleep(10_000)]);
  } finally {
    // Whatever failed above, nothing of this test may outlive it: a child left running with
    // its pipes open keeps `bun test` from ever exiting.
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {}
  }
  expect(pid).toBeGreaterThan(0);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 1000;
  while (alive() && Date.now() < deadline) await Bun.sleep(10);
  expect(alive()).toBe(false);
}, 60_000);

// One table decides what a run may do: terminals, plan mode and consultations read it.
test("every harness and mode takes its permission flags from the shared table", () => {
  const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
  const contains = (argv: string[], flags: readonly string[]) =>
    argv.some((_, i) => flags.every((f, j) => argv[i + j] === f));
  for (const harness of ["claude", "codex", "grok"] as const) {
    const table = PERMISSIONS[harness];
    const bypass = argvFor(harness, config);
    expect(table.bypass).not.toBeNull();
    expect(contains(bypass, table.bypass ?? [])).toBe(true);
    if (table.plan) {
      const plan = argvFor(harness, config, { plan: true });
      expect(contains(plan, table.plan)).toBe(true);
      expect(contains(plan, table.bypass ?? [])).toBe(false);
    } else expect(() => argvFor(harness, config, { plan: true })).toThrow(LaunchError);
    const participant = { harness, model: "m-1" };
    if (table.consult) {
      const consult = consultationArgs(participant, "opinion?");
      expect(contains(consult, table.consult)).toBe(true);
      expect(contains(consult, table.bypass ?? [])).toBe(false);
    } else expect(() => consultationArgs(participant, "opinion?")).toThrow();
  }
  expect(KICKOFF_PERMISSION).toEqual({ start: "plan", review: "bypass" });
});

test("a consultation gets its harness's variables and the basics, no other token", async () => {
  const config = ConfigSchema.parse({ terminals: { bins: { claude: fake } } });
  const store = new CoordinationStore(openDb(":memory:"));
  const input = ConsultationInput.parse({
    requestId: "env",
    location: "x",
    prompt: "Inspect code",
    participants: [
      { harness: "claude", model: "env" },
      { harness: "codex", model: "env" },
    ],
  });
  const q = {
    ...store.createConsultation("user", input, dir, ""),
    snapshot: join(dir, "snapshot"),
  };
  const login = {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    GITHUB_TOKEN: "g",
    AWS_SECRET_ACCESS_KEY: "s",
  };
  const exec = executor(
    () => config,
    async () => login,
  );
  const a = newAttempt({ harness: "claude", model: "env" });
  const { result } = await exec(q, a, new AbortController().signal);
  expect(result.split(" ")).toEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"]);
});

// The probe is bounded even when the CLI leaves a child holding its stdout: killing the CLI
// alone would keep the read waiting for that child.
test("a harness whose --help never ends is unavailable within the probe's bound", async () => {
  const stuck = join(dir, "stuck-cli");
  const pidFile = join(dir, "stuck.pid");
  writeFileSync(stuck, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
  chmodSync(stuck, 0o700);
  const config = ConfigSchema.parse({ terminals: { bins: { claude: stuck } } });
  const started = Date.now();
  try {
    const [claude] = await capabilities(config, { PATH: "/usr/bin:/bin", HOME: dir });
    expect(claude).toMatchObject({ harness: "claude", available: false });
    expect(Date.now() - started).toBeLessThan(15_000);
  } finally {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Already gone with its group.
      }
    }
  }
}, 60_000);
