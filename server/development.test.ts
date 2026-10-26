import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("development isolates its data, API port and remote ingress even with copied config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-dev-config-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      port: 4317,
      remote: { enabled: true, origin: "https://host.test.ts.net", login: "owner@example.com" },
    }),
  );
  const code = `import { DATA_DIR, loadConfig } from ${JSON.stringify(join(import.meta.dir, "config.ts"))}; const c=loadConfig(${JSON.stringify(path)}); console.log(JSON.stringify({data:DATA_DIR,port:c.port,remote:c.remote.enabled}));`;
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "development" };
  delete env.AGENTIC_OS_DATA;
  try {
    const proc = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    const result = await new Response(proc.stdout).json();
    expect(result).toMatchObject({ port: 4320, remote: false });
    expect(result.data).toEndWith("/data/dev");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
