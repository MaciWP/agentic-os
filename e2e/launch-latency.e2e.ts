import { type APIRequestContext, expect, test } from "@playwright/test";
import { stats } from "../scripts/perf-baseline.ts";
import { origin, READY_MS, removeTerminals } from "./helpers.ts";

// How long a launch takes to show something: from the launch request to the first text on the
// server's screen, and to the screen settling (no change for SETTLED_MS, counted from its last
// change). One terminal at a time, removed after each. A shell starts as a login shell and loads
// ~/.zshrc; Claude and Codex start with the login environment the PTY host read once. Grok is
// left out: it keeps no activity. It reports the figures and fails only on a launch that shows
// nothing within READY_MS. No prompt is sent, so the agents spend no tokens. A measurement, not a
// gate: it adds about a minute to the shared serial run, so it runs only when asked for:
// AOS_E2E_LATENCY=1 bun run e2e:isolated e2e/launch-latency.e2e.ts --project main
test.skip(!process.env.AOS_E2E_LATENCY, "set AOS_E2E_LATENCY=1 to measure launch latency");

const headers = { origin, "content-type": "application/json" };
const RUNS = { shell: 5, claude: 3, codex: 3 } as const;
const SETTLED_MS = 1500;

type Sample = { first: number; settled: number | null };

async function launch(request: APIRequestContext, harness: keyof typeof RUNS): Promise<Sample> {
  const start = Date.now();
  const res = await request.post("/api/terminals", { headers, data: { harness, location: "app" } });
  expect(res.ok(), await res.text()).toBe(true);
  const id = ((await res.json()) as { terminal: { id: string } }).terminal.id;
  try {
    let first: number | null = null;
    let text = "";
    let changed = start;
    while (Date.now() - start < READY_MS) {
      const now = Date.now();
      const read = await request.get(`/api/terminals/${id}/text`);
      expect(read.ok(), `GET /api/terminals/${id}/text`).toBe(true);
      const next = ((await read.json()) as { text: string }).text;
      if (next !== text) {
        text = next;
        changed = now;
      }
      if (first === null && /\S/.test(text)) first = now - start;
      if (first !== null && now - changed >= SETTLED_MS) return { first, settled: changed - start };
      await new Promise((r) => setTimeout(r, 100));
    }
    if (first === null) throw new Error(`${harness}: nothing on screen in ${READY_MS / 1000} s`);
    return { first, settled: null };
  } finally {
    await removeTerminals(request, [id]);
  }
}

test("time from launch to first output and to a settled screen", async ({ request }) => {
  test.setTimeout(15 * 60_000);
  const report: Record<string, unknown> = {};
  for (const harness of Object.keys(RUNS) as (keyof typeof RUNS)[]) {
    const samples: Sample[] = [];
    for (let i = 0; i < RUNS[harness]; i++) samples.push(await launch(request, harness));
    const settled = samples.flatMap((s) => (s.settled === null ? [] : [s.settled]));
    report[harness] = {
      firstMs: samples.map((s) => s.first),
      first: stats(samples.map((s) => s.first)),
      settled: settled.length ? stats(settled) : null,
      neverSettled: samples.length - settled.length,
    };
  }
  console.log(`launch-latency ${JSON.stringify(report)}`);
  await test.info().attach("launch-latency.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
});
