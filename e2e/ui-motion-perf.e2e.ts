import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { origin, READY_MS, removeTerminals, resetWorkspace } from "./helpers.ts";

// What the Mesa's status motion costs while nothing else happens: a full Mesa of six agents,
// three working (their spinners) and three waiting for the user (their rings), with the page left alone. It counts
// the frames the compositor draws and the CPU of every Chromium process, for the same build
// under several motion variants, so a change is judged on numbers. Opt-in, since it takes
// minutes: AOS_MOTION_PERF=1, AOS_MOTION_PERF_HEADED=1 to draw on the real display (its
// WindowServer cost too), AOS_MOTION_PERF_LABEL names the run in data/evidence/ui-motion.
const RUN = process.env.AOS_MOTION_PERF === "1";
const HEADED = process.env.AOS_MOTION_PERF_HEADED === "1";
const LABEL = process.env.AOS_MOTION_PERF_LABEL ?? "run";
const EVIDENCE = "data/evidence/ui-motion";
const headers = { origin, "content-type": "application/json" };
const N = 6;
const WAITING = 3;
const CPU_MS = 10_000;
const FRAMES_MS = 5_000;
const REPEATS = 3;

test.use({
  headless: !HEADED,
  storageState: { cookies: [], origins: [] },
  launchOptions: { args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"] },
});

type Variant = "floor" | "before" | "current";
const VARIANTS: Variant[] = ["floor", "before", "current"];

// "floor" drops every motion-safe animation; "current" is the build as it is: the pulses that ask
// for the eye end after three beats and the working spinners step on one shared 8 Hz timer
// (web/motion.ts). "before" brings back what they replaced on 2026-10-08: every pulse looping for
// ever and each spinner on its own smooth CSS loop. Spinners in 8 CSS steps, each at its own
// phase, were measured then too: 24 frames/s against the timer's 8 (data/evidence/ui-motion/w3.json).
async function apply(page: Page, v: Variant) {
  await page.emulateMedia({ reducedMotion: v === "floor" ? "reduce" : "no-preference" });
  await page.evaluate((v) => {
    const w = window as unknown as { __motion?: () => void };
    w.__motion?.();
    w.__motion = undefined;
    if (v !== "before") return;
    const style = document.createElement("style");
    style.textContent =
      "*{animation-iteration-count:infinite!important}[data-spin]{animation:spin 1s linear infinite!important}";
    document.head.append(style);
    w.__motion = () => style.remove();
  }, v);
  await page.waitForTimeout(500);
}

// CPU seconds per Chromium process type, from the browser itself.
async function cpuByType(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as {
    processInfo: { type: string; id: number; cpuTime: number }[];
  };
  await cdp.detach();
  const out: Record<string, number> = {};
  for (const p of processInfo) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
  return out;
}

// macOS WindowServer CPU seconds so far, or null where it cannot be read.
function windowServerSecs() {
  try {
    const pid = execFileSync("pgrep", ["-x", "WindowServer"]).toString().trim().split("\n")[0];
    const t = execFileSync("ps", ["-o", "time=", "-p", pid ?? ""])
      .toString()
      .trim();
    const parts = t.split(":").map(Number);
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  } catch {
    return null;
  }
}

type Cdp = Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>;
async function metrics(cdp: Cdp) {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

// Pass A: nothing injected, the page left alone for CPU_MS.
async function cpuPass(page: Page, browser: Browser, cdp: Cdp) {
  const [c0, m0, w0] = [await cpuByType(browser), await metrics(cdp), windowServerSecs()];
  await page.waitForTimeout(CPU_MS);
  const [c1, m1, w1] = [await cpuByType(browser), await metrics(cdp), windowServerSecs()];
  const pct = (a: number, b: number) => Math.round(((b - a) / (CPU_MS / 1000)) * 1000) / 10;
  const cpu = Object.fromEntries(Object.keys(c1).map((k) => [k, pct(c0[k] ?? 0, c1[k] ?? 0)]));
  const delta = (k: string) => Math.round(((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / 1000;
  return {
    cpuPctOfCore: cpu,
    windowServerPct: w0 !== null && w1 !== null ? pct(w0, w1) : null,
    page: {
      taskSecs: delta("TaskDuration"),
      scriptSecs: delta("ScriptDuration"),
      recalcStyles: delta("RecalcStyleCount"),
      layouts: delta("LayoutCount"),
    },
  };
}

let namesLogged = false;

// Pass B: the frames the compositor draws per second, from a trace.
async function framesPass(page: Page, browser: Browser) {
  await browser.startTracing(page, {
    categories: ["disabled-by-default-devtools.timeline.frame", "viz", "cc"],
  });
  await page.waitForTimeout(FRAMES_MS);
  const buf = await browser.stopTracing();
  const events = (JSON.parse(buf.toString()) as { traceEvents: { name: string }[] }).traceEvents;
  const count = (name: string) => events.filter((e) => e.name === name).length;
  const secs = FRAMES_MS / 1000;
  // The trace's own event names, once: a frame count of 0 must mean no frames, not a renamed event.
  if (!namesLogged) {
    namesLogged = true;
    const names = new Map<string, number>();
    for (const e of events) names.set(e.name, (names.get(e.name) ?? 0) + 1);
    const top = [...names].filter(([n]) => /frame/i.test(n)).sort((a, b) => b[1] - a[1]);
    console.log(`ui-motion frame events ${JSON.stringify(top.slice(0, 15))}`);
  }
  return {
    drawFramePerSec: Math.round((count("DrawFrame") / secs) * 10) / 10,
    beginFramePerSec: Math.round((count("BeginFrame") / secs) * 10) / 10,
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

test.describe("status motion cost", () => {
  test.skip(!RUN, "opt-in: AOS_MOTION_PERF=1");
  const ids: string[] = [];

  test.afterAll(async ({ request }) => {
    await removeTerminals(request, ids);
  });

  test("three working agents and three waiting ones, left alone", async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(900_000);
    await resetWorkspace(request);
    for (let i = 0; i < N; i++) {
      const res = await request.post("/api/terminals", {
        headers,
        data: { harness: "shell", location: "app" },
      });
      expect(res.ok(), await res.text()).toBe(true);
      ids.push(((await res.json()) as { terminal: { id: string } }).terminal.id);
    }
    // Shells give real terminals; the agents' states are fixtures, so no model is started.
    let waiting = new Set<string>();
    await page.route("**/api/terminals", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        response,
        json: {
          ...data,
          terminals: data.terminals.map((t: { id: string }) =>
            ids.includes(t.id)
              ? {
                  ...t,
                  agent: waiting.has(t.id)
                    ? { sessionId: null, state: "needs_you" }
                    : { sessionId: null, state: "working" },
                }
              : t,
          ),
        },
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    // Drawn on the GPU (a canvas), as on the user's Mac: there are no DOM rows to read.
    for (const id of ids)
      await expect(
        page.locator(`section[data-terminal-id="${id}"] .xterm-screen canvas`).first(),
      ).toBeVisible({ timeout: READY_MS });
    await expect(page.locator("[data-phase=working]").first()).toBeVisible();
    // No tile focused: attention skips the one the user is looking at.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Three agents go from working to waiting: a rename makes the server announce the list,
    // and the page reads it again with the new states.
    waiting = new Set(ids.slice(0, WAITING));
    await request.post(`/api/terminals/${ids[N - 1]}/name`, { headers, data: { name: "motion" } });
    await expect(page.locator('[data-part="attention"]')).toHaveCount(WAITING);
    // Long enough for any bounded pulse to end, so the steady state is what is measured.
    await page.waitForTimeout(7_000);
    const env = {
      label: LABEL,
      headed: HEADED,
      working: await page.locator("[data-phase=working]").count(),
      rings: await page.locator('[data-part="attention"]').count(),
      runningAnimations: await page.evaluate(() => document.getAnimations().length),
    };

    const runs = Object.fromEntries(VARIANTS.map((v) => [v, [] as unknown[]])) as Record<
      Variant,
      unknown[]
    >;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    for (let r = 0; r < REPEATS; r++)
      for (const v of VARIANTS) {
        await apply(page, v);
        runs[v].push({
          ...(await cpuPass(page, browser, cdp)),
          ...(await framesPass(page, browser)),
        });
      }
    await cdp.detach();
    await apply(page, "current");

    const summary = Object.fromEntries(
      VARIANTS.map((v) => {
        const rs = runs[v] as {
          drawFramePerSec: number;
          cpuPctOfCore: Record<string, number>;
          windowServerPct: number | null;
        }[];
        const types = [...new Set(rs.flatMap((x) => Object.keys(x.cpuPctOfCore)))];
        return [
          v,
          {
            drawFramePerSec: median(rs.map((x) => x.drawFramePerSec)),
            cpuPctOfCore: Object.fromEntries(
              types.map((t) => [t, median(rs.map((x) => x.cpuPctOfCore[t] ?? 0))]),
            ),
            windowServerPct: HEADED ? median(rs.map((x) => x.windowServerPct ?? 0)) : null,
          },
        ];
      }),
    );
    const report = { ...env, summary, runs };
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${LABEL}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`ui-motion ${JSON.stringify({ ...env, summary }, null, 2)}`);
    expect(env.working).toBeGreaterThan(0);
    expect(env.rings).toBe(WAITING);
    // Once the pulses end nothing loops in CSS, and the page draws little more than when still.
    expect(env.runningAnimations).toBe(0);
    const fps = (v: Variant) => (summary[v] as { drawFramePerSec: number }).drawFramePerSec;
    expect(fps("current")).toBeLessThanOrEqual(fps("floor") + 10);
  });
});
