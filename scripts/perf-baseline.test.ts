import { afterAll, expect, test } from "bun:test";
import { attribute, stallDuring, stats } from "./perf-baseline.ts";

test("percentiles are nearest-rank over the sorted samples", () => {
  const xs = Array.from({ length: 20 }, (_, i) => 20 - i);
  expect(stats(xs)).toEqual({ n: 20, p50: 10, p95: 19, max: 20 });
  expect(stats([7])).toEqual({ n: 1, p50: 7, p95: 7, max: 7 });
  expect(() => stats([])).toThrow("no samples");
});

test("startup time goes to the .zshrc line that ran it, and no traced text comes out", () => {
  const trace = [
    "+100.000000 /etc/zprofile:1> eval /usr/libexec/path_helper",
    "+100.100000 /Users/me/.zshrc:5> export OPENAI_API_KEY=sk-secret",
    "+100.200000 /Users/me/.zshrc:6> source /Users/me/.sdkman/bin/sdkman-init.sh",
    "++100.250000 /Users/me/.sdkman/bin/sdkman-init.sh:10> some_setup",
    "++101.200000 /Users/me/.sdkman/bin/sdkman-init.sh:90> more",
    "+101.300000 /Users/me/.zshrc:41> compinit",
    "+101.800000 /Users/me/.zshrc:43> exit",
    "not a trace line",
  ].join("\n");
  const r = attribute(trace);
  expect(r.totalMs).toBeCloseTo(1800, 3);
  expect(r.lines.map(([where]) => where)).toEqual([
    ".zshrc:6",
    ".zshrc:41",
    ".zshrc:5",
    ".zshrc:43",
  ]);
  expect(r.lines[0]?.[1]).toBeCloseTo(1100, 3);
  expect(r.lines[1]?.[1]).toBeCloseTo(500, 3);
  expect(JSON.stringify(r)).not.toContain("secret");
  expect(attribute("")).toEqual({ totalMs: 0, lines: [] });
});

// A server, in a process of its own like the real one, whose /busy handler holds its one
// thread as a synchronous report does.
const SERVER = `
const s = Bun.serve({ port: 0, fetch(req) {
  if (new URL(req.url).pathname === "/busy") { const end = performance.now() + 120; while (performance.now() < end) {} }
  return new Response("ok");
} });
console.log(s.port);`;
const server = Bun.spawn([process.execPath, "-e", SERVER], { stdout: "pipe", stderr: "inherit" });
afterAll(() => server.kill());

async function portOf(proc: typeof server): Promise<number> {
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return Number(new TextDecoder().decode(value).trim());
}

test("a handler that blocks the server shows as a health stall; a quick one does not", async () => {
  const base = `http://localhost:${await portOf(server)}`;
  const busy = await stallDuring(base, "/busy");
  expect(busy.ms).toBeGreaterThanOrEqual(120);
  expect(busy.stall).toBeGreaterThanOrEqual(60);
  const quick = await stallDuring(base, "/quick");
  expect(quick.stall).toBeLessThan(60);
});
