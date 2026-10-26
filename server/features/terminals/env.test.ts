import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLoginEnv, prependPath } from "./env.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-login-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function shell(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("loadLoginEnv", () => {
  test("reads the login shell's environment", async () => {
    const sh = shell("ok", `printf '\\0__AOS_ENV__\\0A=1\\0'`);
    expect((await loadLoginEnv(sh, 5_000)).A).toBe("1");
  });

  // A profile that starts a background job leaves it holding stdout: killing the shell alone
  // never ends the read.
  test("a shell whose child holds stdout open fails at the timeout", async () => {
    const sh = shell("hang", "sleep 30 &\nsleep 30");
    const started = Date.now();
    await expect(loadLoginEnv(sh, 300)).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);
});

describe("prependPath", () => {
  test("POSIX joins with a colon and keeps a default when PATH is missing", () => {
    expect(prependPath({ PATH: "/usr/bin" }, ["/app/bin"], "darwin").PATH).toBe(
      "/app/bin:/usr/bin",
    );
    expect(prependPath({}, ["/app/bin"], "darwin").PATH).toBe("/app/bin:/usr/bin:/bin");
  });

  test("Windows replaces the Path entry with one PATH joined by semicolons", () => {
    const env = prependPath({ Path: "C:\\Windows", HOME: "x" }, ["C:\\aos\\bin"], "win32");
    expect(env).toEqual({ HOME: "x", PATH: "C:\\aos\\bin;C:\\Windows" });
  });
});
