import { type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";
import { origin, removeTerminals, waitReady } from "./helpers.ts";

// The Mesa under heavy output: six shells print several MB each at the same time, twice, and
// the Mesa is left and opened again a few times. It reports frame times, long animation frames
// and the heap after GC. It fails when output is lost, a window gives up on its terminal, or the
// heap grows the way a leak would: once every screen's scrollback is full, a second equal burst
// or a remount must not add a burst's worth of memory. Only shells are launched, and removed.
const headers = { origin, "content-type": "application/json" };
const N = 6;
const LINES = 150_000;
const GAVE_UP = /no daba abasto|desbordó el búfer|Se ha cortado la conexión/;

type Frames = { fps: number; p50: number; p99: number; max: number; over50: number };
type Loaf = { count: number; totalMs: number; maxMs: number };

// The JS heap plus the array buffers behind it, where xterm keeps its screen and scrollback.
async function heapMB(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize, backingStorageSize } = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number;
    backingStorageSize?: number;
  };
  if (backingStorageSize === undefined) throw new Error("this Chromium reports no array buffers");
  return Math.round((usedSize + backingStorageSize) / 1e5) / 10;
}

// Frame times and long animation frames from now until the returned stop() is called.
async function record(page: Page) {
  await page.evaluate(() => {
    const st = { frames: [] as number[], loafs: [] as number[], run: true, t0: performance.now() };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (st.run) st.loafs.push(e.duration);
    }).observe({ type: "long-animation-frame" });
    let last = performance.now();
    const tick = (t: number) => {
      st.frames.push(t - last);
      last = t;
      if (st.run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { __perf: typeof st }).__perf = st;
  });
  return () =>
    page.evaluate((): { frames: Frames; loaf: Loaf } => {
      const st = (
        window as unknown as {
          __perf: { frames: number[]; loafs: number[]; run: boolean; t0: number };
        }
      ).__perf;
      st.run = false;
      const secs = (performance.now() - st.t0) / 1000;
      const sorted = [...st.frames].sort((a, b) => a - b);
      const at = (p: number) => Math.round(sorted[Math.floor(p * (sorted.length - 1))] ?? 0);
      return {
        frames: {
          fps: Math.round(st.frames.length / secs),
          p50: at(0.5),
          p99: at(0.99),
          max: at(1),
          over50: st.frames.filter((f) => f > 50).length,
        },
        loaf: {
          count: st.loafs.length,
          totalMs: Math.round(st.loafs.reduce((a, d) => a + d, 0)),
          maxMs: Math.round(Math.max(0, ...st.loafs)),
        },
      };
    });
}

async function type(tile: Locator, line: string) {
  await tile.locator(".xterm-helper-textarea").focus();
  await tile.page().keyboard.type(line);
  await tile.page().keyboard.press("Enter");
}

// Every shell prints LINES lines at once; each then prints a marker the typed line does not
// contain, so seeing it means its whole output reached the screen.
async function burst(page: Page, tiles: Locator, round: number) {
  const started = Date.now();
  for (let i = 0; i < N; i++)
    await type(
      tiles.nth(i),
      `seq -f 'line %g lorem ipsum dolor sit amet consectetur' ${LINES}; echo END_$((${round}*100+${i}))x`,
    );
  for (let i = 0; i < N; i++)
    await expect(tiles.nth(i).locator(".xterm-rows")).toContainText(`END_${round * 100 + i}x`, {
      timeout: 180_000,
    });
  await expect(page.getByText(GAVE_UP)).toHaveCount(0);
  return Math.round((Date.now() - started) / 100) / 10;
}

test.describe("terminal load", () => {
  const ids: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < N; i++) {
      const res = await request.post("/api/terminals", {
        headers,
        data: { harness: "shell", location: "app" },
      });
      expect(res.ok(), await res.text()).toBe(true);
      ids.push(((await res.json()) as { terminal: { id: string } }).terminal.id);
    }
  });

  test.afterAll(async ({ request }) => {
    await removeTerminals(request, ids);
  });

  test("six shells printing MBs at once lose nothing, and memory stays flat", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    const tiles = page.locator("section[aria-label^='Shell en ']");
    await expect(tiles).toHaveCount(N);
    for (let i = 0; i < N; i++) await waitReady(tiles.nth(i));

    const report: Record<string, unknown> = { terminals: N, bytesPerBurst: N * LINES * 48 };
    report.heapIdleMB = await heapMB(cdp);

    for (const round of [1, 2]) {
      const stop = await record(page);
      const secs = await burst(page, tiles, round);
      report[`burst${round}`] = { secs, ...(await stop()) };
      report[`heapAfterBurst${round}MB`] = await heapMB(cdp);
    }
    report.domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);

    // Leave the Mesa and come back: every terminal is mounted again from its snapshot.
    for (let i = 1; i <= 15; i++) {
      await page.getByRole("link", { name: "Inicio", exact: true }).click();
      await expect(page.locator(".xterm")).toHaveCount(0);
      await page.getByRole("link", { name: "Mesa", exact: true }).click();
      await expect(tiles).toHaveCount(N);
      for (let t = 0; t < N; t++)
        await expect(tiles.nth(t).locator(".xterm-rows")).toContainText(`END_${200 + t}x`);
      if (i % 5 === 0) report[`heapAfter${i}RemountsMB`] = await heapMB(cdp);
    }
    report.heapAfterRemountsMB = report.heapAfter15RemountsMB;
    report.domNodesAfterRemounts = await page.evaluate(
      () => document.getElementsByTagName("*").length,
    );
    console.log(`terminal-perf ${JSON.stringify(report, null, 2)}`);

    // The first burst fills every scrollback; past that, more output or a remount only
    // replaces what is there.
    const full = report.heapAfterBurst1MB as number;
    expect(report.heapAfterBurst2MB as number).toBeLessThan(full * 1.5);
    expect(report.heapAfterRemountsMB as number).toBeLessThan(full * 1.5);
  });
});
