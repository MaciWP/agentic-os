import { homedir } from "node:os";
import { Hono } from "hono";
import { z } from "zod";
import { dayOf } from "../../../shared/days.ts";
import { ISSUE_KEY } from "../../../shared/envs.ts";
import type { Services } from "../../deps.ts";
import { getIssue } from "../jira/issues.ts";
import { readPlanUsage } from "../system/plan-usage.ts";
import { activityOf } from "./activity.ts";
import { briefLoader, type JiraBrief } from "./briefs.ts";
import type { UsageIngest } from "./ingest.ts";
import { type EffortJudge, JUDGE_MODEL, judgeReport } from "./judge.ts";
import { effortCalls, logPoseReport, pricedCalls, readLogPose } from "./logpose.ts";
import { periodCut, usagePeriod } from "./period.ts";
import { priceOf } from "./pricing.ts";
import type { Cut } from "./report.ts";
import { usageReport } from "./report.ts";
import { type RouterLogs, readRouterLogs, routerLogFiles, routerReport } from "./router.ts";
import type { LogPoseView } from "./types.ts";

// Log Pose classifies with Sonnet; its router log carries tokens, not dollars.
const LOG_POSE_MODEL = "claude-sonnet-5-5";
const BASELINE_MS = 28 * 86_400_000;
// A read older than this runs again before a report, so the page shows the turn just ended.
export const FRESH_MS = 60_000;
// The activity strips in Agentes are polled, so their read can be staler only by half a minute.
export const ACTIVITY_FRESH_MS = 30_000;

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00`)), "not a date");
// No `from`: the whole history up to `to`.
export const UsageQuery = z
  .object({ from: Day.optional(), to: Day })
  .refine((q) => !q.from || q.from <= q.to, "from is after to");
// `offset` counts periods back from the current one; ten years of months at most.
export const PeriodQuery = z.object({
  kind: z.enum(["week", "month"]),
  offset: z.coerce.number().int().min(0).max(120).default(0),
});
// A period's bounds as the report reads them: the local days it touches, cut to its instants.
function cutRange({ b, before }: ReturnType<typeof periodCut>) {
  const iso = (d: Date) => d.toISOString();
  return {
    from: dayOf(b.start),
    to: dayOf(new Date(b.end.getTime() - 1)),
    cut: { from: iso(b.start), to: iso(b.end) },
    before: { from: iso(before.start), to: iso(before.end) },
  };
}
// A span to judge, at most five weeks; its end is cut to now.
export const JudgeSpan = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime() })
  .refine((s) => s.from < s.to, "from is after to")
  .refine((s) => Date.parse(s.to) - Date.parse(s.from) <= 35 * 86_400_000, "longer than 35 days");
export const BriefsQuery = z.object({
  keys: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.string().regex(ISSUE_KEY)).min(1).max(100)),
});

export function usageRoutes(
  {
    config,
    db,
    jira,
    objectives,
    judge,
  }: Pick<Services, "config" | "db" | "jira" | "objectives"> & { judge?: EffortJudge },
  ingest: UsageIngest,
  get?: (key: string) => Promise<JiraBrief>,
  plan = readPlanUsage,
  home = homedir(),
) {
  const briefs = briefLoader(
    get ??
      (async (key) => {
        const t = await getIssue(jira, config, key);
        return { title: t.summary, status: t.status };
      }),
  );
  // When Claude's weekly limit resets, as the plan reads now; null when it cannot be read.
  const weekly = async () => {
    const reading = await plan();
    const week = "windows" in reading ? reading.windows.find((w) => w.minutes === 10_080) : null;
    return { weeklyResetAt: week?.resetAt ?? null };
  };
  // Log Pose against the hook it replaced: the hook's last four weeks before the mod's first run.
  const logPoseView = async (logs: RouterLogs, cut: Cut): Promise<LogPoseView | null> => {
    const mod = logs.runs.filter((r) => r.engine === "mod");
    const first = mod[0]?.at;
    if (first === undefined) return null;
    const pose = await readLogPose(home);
    const before = {
      from: new Date(first - BASELINE_MS).toISOString(),
      to: new Date(first).toISOString(),
    };
    const hook = logs.runs.filter((r) => r.engine === "hook");
    return {
      report: logPoseReport(
        pose,
        mod,
        priceOf(config.pricing, LOG_POSE_MODEL),
        cut,
        pricedCalls(db, config.pricing, cut.from, cut.to),
      ),
      mod: routerReport(db, { ...logs, runs: mod }, cut),
      baseline: { ...routerReport(db, { ...logs, runs: hook }, before), ...before },
      efforts: {
        before: effortCalls(db, before.from, before.to),
        // Only from the mod's first run: the period may start before it.
        after: effortCalls(db, cut.from > before.to ? cut.from : before.to, cut.to),
      },
      judge: await judgeReport(
        judge?.store ?? null,
        pose,
        cut,
        home,
        priceOf(config.pricing, JUDGE_MODEL),
        judge?.available ?? false,
        config.usage.judgeAuto,
      ),
    };
  };
  return (
    new Hono()
      .get("/", async (c) => {
        // `kind` asks for the period the chart above shows, to its exact hour; else local days.
        const asked =
          c.req.query("kind") === undefined ? null : PeriodQuery.safeParse(c.req.query());
        const query = asked ? null : UsageQuery.safeParse(c.req.query());
        if (asked && !asked.success)
          return c.json({ error: "bad_request", detail: asked.error.issues }, 400);
        if (query && !query.success)
          return c.json({ error: "bad_request", detail: query.error.issues }, 400);
        const last = ingest.last;
        if (!last || Date.now() - Date.parse(last.startedAt) > FRESH_MS) await ingest.run();
        const run = ingest.last;
        const period = asked?.success ? cutRange(periodCut(db, asked.data, await weekly())) : null;
        const range = period ?? query?.data;
        if (!range) return c.json({ error: "bad_request" }, 400);
        const logs = period ? await readRouterLogs(await routerLogFiles(db, home)) : null;
        const router = period && logs ? routerReport(db, logs, period.cut) : null;
        const logPose = period && logs ? await logPoseView(logs, period.cut) : null;
        return c.json({
          ...(await usageReport(db, config, range, objectives.sessions())),
          router,
          logPose,
          ingest: {
            lastRunAt: run?.startedAt ?? null,
            ms: run?.ms ?? null,
            files: run?.files ?? 0,
            errors: run?.errors ?? [],
          },
        });
      })
      .get("/period", async (c) => {
        const query = PeriodQuery.safeParse(c.req.query());
        if (!query.success)
          return c.json({ error: "bad_request", detail: query.error.issues }, 400);
        const last = ingest.last;
        if (!last || Date.now() - Date.parse(last.startedAt) > FRESH_MS) await ingest.run();
        return c.json(usagePeriod(db, config, query.data, await weekly(), objectives.sessions()));
      })
      .get("/activity", async (c) => {
        const last = ingest.last;
        if (!last || Date.now() - Date.parse(last.startedAt) > ACTIVITY_FRESH_MS)
          await ingest.run();
        return c.json(activityOf(db, Date.now()));
      })
      // The effort judge over a span, on Sonnet: 202 with the pass, which runs on.
      .post("/effort-judge", async (c) => {
        const body = JudgeSpan.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const to = new Date(Math.min(Date.parse(body.data.to), Date.now())).toISOString();
        if (to <= body.data.from)
          return c.json({ error: "bad_request", detail: "in the future" }, 400);
        if (!judge) return c.json({ error: "unavailable" }, 503);
        return c.json({ run: judge.start({ from: body.data.from, to }, "manual") }, 202);
      })
      .get("/jira", async (c) => {
        const query = BriefsQuery.safeParse(c.req.query());
        if (!query.success)
          return c.json({ error: "bad_request", detail: query.error.issues }, 400);
        if (!config.jira) return c.json({ disabled: true as const });
        return c.json({ briefs: await briefs(query.data.keys) });
      })
  );
}
