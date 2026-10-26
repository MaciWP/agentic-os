import { randomBytes } from "node:crypto";
import type { RunResult } from "./run.ts";

// One Windows PowerShell kept open between calls. Starting one costs about 170 ms of CPU before
// any work, and a CIM query inside a warm one about 16 ms (measured on the PC, 2026-10-11): a
// header polling the process list every 5 s spent 6 % of a core on starts alone. The session
// lives while calls come and exits IDLE_MS after the last one, so an unwatched worker runs none.
// Calls go one at a time. Each is a base64 line on stdin; its output lines end with a marker
// line that carries the exit code and, on failure, the error. A call that times out, overflows
// or loses the process ends the session, and the next call starts a fresh one.

export const IDLE_MS = 30_000;
const MAX_BYTES = 1024 * 1024;

// The loop PowerShell runs. Every error is terminating, so a failed query reports code 1 as a
// separate `powershell -Command` would.
const loop = (marker: string) => `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $code = 0; $err = ''
  try {
    $ErrorActionPreference = 'Stop'
    $cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    foreach ($o in @(Invoke-Expression $cmd)) { [Console]::Out.WriteLine([string]$o) }
  } catch {
    $code = 1
    $err = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.ToString()))
  }
  [Console]::Out.WriteLine('${marker} ' + $code + ' ' + $err)
  [Console]::Out.Flush()
}`;

// powershell.exe with the loop, as -EncodedCommand (UTF-16LE base64): no quoting to get wrong.
export const powershellArgv = (marker: string) => [
  "powershell.exe",
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(loop(marker), "utf16le").toString("base64"),
];

type Call = { lines: string[]; bytes: number; done: (r: RunResult) => void };
type Proc = Bun.Subprocess<"pipe", "pipe", "ignore">;

export class PsSession {
  private proc?: Proc;
  private marker = "";
  private call?: Call;
  private idle?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly argv: (marker: string) => string[] = powershellArgv,
    private readonly idleMs = IDLE_MS,
  ) {}

  run(command: string, timeoutMs: number): Promise<RunResult> {
    const next = this.queue.then(() => this.exec(command, timeoutMs));
    this.queue = next.catch(() => {});
    return next;
  }

  // The session's process id, or null when none runs.
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  private exec(command: string, timeoutMs: number): Promise<RunResult> {
    clearTimeout(this.idle);
    const proc = this.proc ?? this.start();
    return new Promise<RunResult>((resolve) => {
      const timer = setTimeout(() => this.end({ code: null, timedOut: true }), timeoutMs);
      this.call = {
        lines: [],
        bytes: 0,
        done: (r) => {
          clearTimeout(timer);
          this.call = undefined;
          if (this.proc) {
            this.idle = setTimeout(() => this.stop(), this.idleMs);
            this.idle.unref?.();
          }
          resolve(r);
        },
      };
      try {
        proc.stdin.write(`${Buffer.from(command, "utf8").toString("base64")}\n`);
        void proc.stdin.flush();
      } catch (err) {
        this.end({ code: null, stderr: (err as Error).message });
      }
    });
  }

  private start(): Proc {
    this.marker = `@@aos-end-${randomBytes(8).toString("hex")}@@`;
    const proc = Bun.spawn(this.argv(this.marker), {
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    // Never keeps the server alive; the loop ends with the server, when stdin closes.
    proc.unref();
    this.proc = proc;
    void this.read(proc);
    return proc;
  }

  private async read(proc: Proc) {
    const decoder = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of proc.stdout) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        for (const raw of lines) this.line(raw.replace(/\r$/, ""));
      }
    } catch {
      // A killed process ends the read; the call it held ends below.
    }
    if (this.proc === proc) {
      this.proc = undefined;
      this.end({ code: null, stderr: "PowerShell exited" });
    }
  }

  private line(text: string) {
    const call = this.call;
    if (!call) return;
    if (text.startsWith(`${this.marker} `)) {
      const [, code, err = ""] = text.split(" ");
      call.done({
        code: Number(code),
        stdout: call.lines.map((l) => `${l}\n`).join(""),
        stderr: Buffer.from(err, "base64").toString("utf8"),
        timedOut: false,
        truncated: false,
      });
      return;
    }
    call.bytes += Buffer.byteLength(text) + 1;
    if (call.bytes > MAX_BYTES) this.end({ code: null, truncated: true });
    else call.lines.push(text);
  }

  // Ends the current call without its marker: the session's state is unknown, so it goes too.
  private end(r: Partial<RunResult>) {
    const call = this.call;
    this.stop();
    call?.done({
      code: null,
      stdout: call.lines.map((l) => `${l}\n`).join(""),
      stderr: "",
      timedOut: false,
      truncated: false,
      ...r,
    });
  }

  stop() {
    clearTimeout(this.idle);
    const proc = this.proc;
    this.proc = undefined;
    proc?.kill();
  }
}
