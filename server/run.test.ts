import { describe, expect, test } from "bun:test";
import { run, STDERR_TAIL } from "./run.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A killed process is reaped by launchd, not at once.
async function gone(pid: number) {
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(50);
  return !alive(pid);
}

describe("run", () => {
  test("returns stdout, the exit code and stderr", async () => {
    const r = await run(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 10_000 });
    expect(r).toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
      timedOut: false,
      truncated: false,
    });
  });

  test("a command past its timeout is killed", async () => {
    const started = performance.now();
    const r = await run(["/bin/sleep", "30"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  // The child exits at once; the grandchild it left keeps stdout open. Without the group kill
  // the read waits for the grandchild, 30 s here.
  test("a grandchild holding the pipe does not hang past the timeout, and is killed", async () => {
    const started = performance.now();
    const r = await run(["/bin/sh", "-c", "/bin/sleep 30 & echo $!; exit 0"], { timeoutMs: 500 });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(1);
    expect(await gone(grandchild)).toBe(true);
  });

  test("stdout past the cap is cut and the command killed", async () => {
    const r = await run(["/usr/bin/yes"], { timeoutMs: 10_000, maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stdout.length).toBe(1000);
  });

  test("only the tail of stderr is kept", async () => {
    const r = await run(["/bin/sh", "-c", `printf 'a%.0s' $(seq 1 5000) >&2; printf END >&2`], {
      timeoutMs: 10_000,
    });
    expect(r.stderr.length).toBe(STDERR_TAIL);
    expect(r.stderr.endsWith("END")).toBe(true);
  });

  test("the caller's signal kills the command", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const started = performance.now();
    const r = await run(["/bin/sleep", "30"], { timeoutMs: 30_000, signal: ctrl.signal });
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("input goes to stdin, which is closed after it; without input stdin is empty", async () => {
    const cat = await run(["/bin/cat"], { timeoutMs: 10_000, input: "patch\n" });
    expect(cat).toMatchObject({ code: 0, stdout: "patch\n", timedOut: false });
    expect((await run(["/bin/cat"], { timeoutMs: 10_000 })).stdout).toBe("");
  });

  test("a binary that does not exist rejects", async () => {
    await expect(run(["/nonexistent/aos-binary"], { timeoutMs: 1000 })).rejects.toThrow();
  });
});
