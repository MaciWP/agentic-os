import { afterEach, expect, test } from "bun:test";
import { PsSession, powershellArgv } from "./ps-session.ts";

// A stand-in for the PowerShell loop, speaking the same protocol: `echo:a|b` prints a and b,
// `fail:why` reports code 1, `hang` never answers, `die` exits, `pid` prints its pid.
const FAKE = `
const marker = process.argv.at(-1);
let rest = "";
for await (const chunk of Bun.stdin.stream()) {
  const lines = (rest + new TextDecoder().decode(chunk)).split("\\n");
  rest = lines.pop();
  for (const line of lines) {
    const cmd = Buffer.from(line, "base64").toString("utf8");
    if (cmd === "hang") continue;
    if (cmd === "die") process.exit(3);
    if (cmd === "pid") process.stdout.write(process.pid + "\\r\\n" + marker + " 0 \\r\\n");
    else if (cmd.startsWith("echo:"))
      process.stdout.write(cmd.slice(5).split("|").map((l) => l + "\\r\\n").join("") + marker + " 0 \\n");
    else if (cmd.startsWith("fail:"))
      process.stdout.write(marker + " 1 " + Buffer.from(cmd.slice(5)).toString("base64") + "\\n");
  }
}`;

const sessions: PsSession[] = [];
const fake = (idleMs = 30_000) => {
  const s = new PsSession((marker) => [process.execPath, "-e", FAKE, marker], idleMs);
  sessions.push(s);
  return s;
};
afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
});

test("a call returns its lines and code 0", async () => {
  const r = await fake().run("echo:one|dos ñ", 5_000);
  expect(r).toEqual({
    code: 0,
    stdout: "one\ndos ñ\n",
    stderr: "",
    timedOut: false,
    truncated: false,
  });
});

test("calls share one process and run in order", async () => {
  const s = fake();
  const [a, b, c] = await Promise.all([
    s.run("pid", 5_000),
    s.run("echo:second", 5_000),
    s.run("pid", 5_000),
  ]);
  expect(b?.stdout).toBe("second\n");
  expect(a?.stdout).toBe(c?.stdout as string);
  expect(Number(a?.stdout)).toBe(s.pid as number);
});

test("a failure reports code 1 and the error", async () => {
  const r = await fake().run("fail:no such class", 5_000);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe("no such class");
});

test("a timeout ends the session; the next call starts a new one", async () => {
  const s = fake();
  const before = (await s.run("pid", 5_000)).stdout;
  const late = await s.run("hang", 100);
  expect(late).toMatchObject({ code: null, timedOut: true });
  expect(s.pid).toBeNull();
  const after = (await s.run("pid", 5_000)).stdout;
  expect(after).not.toBe(before);
});

test("a process that dies mid-call ends that call, and the next one recovers", async () => {
  const s = fake();
  expect((await s.run("die", 5_000)).code).toBeNull();
  expect((await s.run("echo:back", 5_000)).stdout).toBe("back\n");
});

test("the session exits once idle", async () => {
  const s = fake(50);
  await s.run("pid", 5_000);
  expect(s.pid).not.toBeNull();
  await Bun.sleep(150);
  expect(s.pid).toBeNull();
});

test("the real loop goes to powershell.exe as an encoded command", () => {
  const argv = powershellArgv("@@m@@");
  expect(argv.slice(0, 5)).toEqual([
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  const script = Buffer.from(argv[5] as string, "base64").toString("utf16le");
  expect(script).toContain("[Console]::Out.WriteLine('@@m@@ ' + $code + ' ' + $err)");
});
