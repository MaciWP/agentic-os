import { describe, expect, test } from "bun:test";
import { failQuery, renderWith } from "../../test-render.tsx";
import { skillRows, subagentRows } from "./columns.tsx";
import { effortsOf } from "./effort.tsx";
import { UsagePage } from "./page.tsx";
import {
  type TicketUsage,
  tokenText,
  type UsageLine,
  type UsageReport,
  type UsageSearch,
  type UsageSession,
} from "./queries.ts";

const line = (key: string, over: Partial<UsageLine> = {}): UsageLine => ({
  key,
  calls: 1,
  tokens: { input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 },
  cost: 0.5,
  unpricedTokens: 0,
  longCalls: 0,
  saved: 0.2,
  ...over,
});

const session = (over: Partial<UsageSession> = {}): UsageSession => ({
  ...line("s"),
  harness: "codex",
  sessionId: "01a0cd65-0000-7000-8000-00000000beef",
  ticket: "ABC-1033",
  location: "app",
  cwd: "/r/app",
  branch: "",
  terminal: null,
  models: ["gpt-x"],
  first: "2026-10-05T10:00:00Z",
  last: "2026-10-05T11:00:00Z",
  ...over,
});

const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];
const usage = (over: Partial<TicketUsage> = {}): TicketUsage => ({
  models: [line("claude-opus-5-5")],
  skills: [line("flow")],
  subagents: [],
  harnesses: [line("codex")],
  sessions: [session()],
  sessionCount: 1,
  first: "2026-10-05T10:00:00Z",
  last: "2026-10-05T11:00:00Z",
  activeHours: 1,
  daily: { cost: [0, 0.25, 0, 0, 0.25], tokens: [0, 580, 0, 0, 580] },
  ...over,
});

const RANGE = { from: "2026-10-01", to: "2026-10-05" };
const report = (over: Partial<UsageReport> = {}): UsageReport => ({
  ...RANGE,
  firstDay: "2026-09-01",
  goals: {},
  days: DAYS,
  total: line("total", { calls: 3, cost: 1.25, unpricedTokens: 40 }),
  byTicket: [line("ABC-1033"), line("")],
  byLocation: [line("abc-1033")],
  byModel: [line("claude-opus-5-5"), line("gpt-x", { cost: null, unpricedTokens: 40 })],
  bySkill: [line("flow")],
  bySubagent: [line("Explore")],
  byRole: [line("lead"), line("advisor", { cost: 0.4, longCalls: 1 })],
  bySession: [],
  events: {
    skills: [{ name: "drillme-clarify", detail: "", count: 2 }],
    commands: [{ name: "/dev-workflow", detail: "", count: 4 }],
    subagents: [
      { name: "Explore", detail: "haiku", count: 3 },
      { name: "Explore", detail: "", count: 1 },
    ],
    tools: [{ name: "Bash", detail: "", count: 9 }],
    mcp: [{ name: "github", detail: "", count: 2 }],
    hooks: [
      {
        name: "graphify-nudge.sh",
        ok: 0,
        block: 0,
        error: 6,
        timeout: 0,
        avgMs: 27,
        maxMs: 40,
        totalMs: 162,
      },
    ],
  },
  tickets: { "*": usage(), "ABC-1033": usage(), "": usage({ sessions: [], sessionCount: 0 }) },
  previous: { from: "2026-09-26", to: "2026-09-30", total: line("total"), byTicket: [] },
  byModelRole: [line("lead|claude-opus-5-5"), line("advisor|claude-opus-5-5")],
  repriced: { "claude-opus-5-5": { "claude-sonnet-5-5": 0.3 } },
  router: null,
  logPose: null,
  byEffort: [line("high"), line("medium"), line("")],
  advisorSessions: 1,
  claudeSessions: 2,
  unpriced: ["gpt-x"],
  ingest: { lastRunAt: null, ms: 10, files: 3, errors: [] },
  ...over,
});

const BRIEFS = {
  briefs: {
    "ABC-1033": { title: "Login roto", status: { name: "En curso", category: "indeterminate" } },
  },
};

const WEEK: UsageSearch = {};
const KEY = ["usage", "week", 0];
const render = (r: UsageReport, search: UsageSearch = WEEK, jira: unknown = BRIEFS) =>
  renderWith(<UsagePage search={search} />, [
    [KEY, r],
    [["usage-jira", ["ABC-1033"]], jira],
  ]);

describe("usage page", () => {
  test("one tab per topic: spend opens, the rest are one click away", async () => {
    const html = await render(report());
    expect(html).toContain("1,25");
    expect(html).toMatch(/aria-current="true"[^>]*>.*?Todos los tickets/s);
    expect(html).toContain("Login roto");
    expect(html).toContain("Sin ticket");
    // Six topics in order, spend selected; only its panel is in the page.
    const tabs = [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/gs)].map((m) =>
      (m[1] ?? "").replace(/<[^>]+>/g, ""),
    );
    expect(tabs.map((t) => t.replace(/\d+$/, ""))).toEqual([
      "Gasto y tickets",
      "Modelos",
      "Log Pose",
      "Router y skills",
      "Salud",
      "Inventario",
    ]);
    expect(html).toMatch(/aria-selected="true"[^>]*>.*?Gasto y tickets/s);
    // Radix keeps every panel's box; the closed ones are hidden and empty.
    const panels = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);
    expect(panels).toHaveLength(6);
    expect(panels.filter((p) => !/\shidden/.test(p))).toHaveLength(1);
    expect(html).not.toContain('aria-label="Hooks"');
    // What is broken shows on the Salud tab from any other: the hook's 6 failed runs.
    expect(html).toContain('aria-label="6 fallos"');
    // No emoji stands in for an icon.
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);

    const models = await render(report(), { tab: "modelos" });
    for (const panel of [
      "Quién usa cada modelo",
      "¿Y si fuera otro modelo?",
      "Gasto por nivel de effort",
    ])
      expect(models).toContain(`aria-label="${panel}"`);
    // The advisor's share of a model is its own part of the bar.
    expect(models).toMatch(/title="Advisor: [^"]*0,50/);

    const health = await render(report(), { tab: "salud" });
    // The cost is the API's price, not a bill; the model with no price is named there, once.
    expect(health).toMatch(
      /role="note".*?Coste equivalente en la API.*?no se cobra por token.*?Sin precio, fuera del coste.*?gpt-x/s,
    );
    // Hooks that fail are flagged, and the failed runs are the hook's red part of its bar.
    expect(health).toContain("6 fallos");
    expect(health).toContain("graphify-nudge.sh");
    expect(health).toContain('title="falla: 6"');
    expect(health).toContain('aria-label="Hooks"');
    expect(health).toContain("sin datos del router en este periodo");

    // The inventory is a tab of its own now, open with every count panel.
    const inventory = await render(report(), { tab: "inventario" });
    for (const panel of ["Comandos", "Herramientas", "Servidores MCP"])
      expect(inventory).toContain(`aria-label="${panel}"`);
  });

  test("a clean period leaves the Salud tab unmarked", async () => {
    const html = await render(report({ events: { ...report().events, hooks: [] } }));
    expect(html).not.toMatch(/aria-label="\d+ fallos?"/);
  });

  test("effort and advisor: the advisor's share, high effort's share, levels low to high", async () => {
    const html = await render(report());
    const section = html.slice(html.indexOf('aria-label="Gasto en este periodo"'));
    // The advisor is 0,40 of 1,25 in one of the period's sessions.
    expect(section).toMatch(/32\s%\s*del periodo ·\s*1 llamada, [^<]*cada una/);
    expect(section).toContain("en 1 de 2 sesiones de Claude");
    // high is half of the calls with a level; the one without stays out and is named.
    expect(section).toMatch(/50\s%/);
    expect(section).toContain("1 llamada sin nivel");
    // 32 % of the spend is past the advisor's alarm of 15 %.
    expect(section).toMatch(/fuera<\/span><span[^>]*>· objetivo ≤ 10 %/);
    expect(
      effortsOf([line(""), line("xhigh"), line("new"), line("low")]).map((l) => l.key),
    ).toEqual(["low", "xhigh", "new", ""]);
  });

  test("a failed refresh keeps the report, with a warning; never read, the error", async () => {
    const kept = await renderWith(
      <UsagePage search={WEEK} />,
      [[["usage-jira", ["ABC-1033"]], BRIEFS]],
      failQuery(KEY, report(), "db locked"),
    );
    expect(kept).toContain("lo que ves puede estar desfasado: db locked");
    expect(kept).toContain("Login roto");
    const blank = await renderWith(<UsagePage search={WEEK} />, [], failQuery(KEY));
    expect(blank).toContain("No se han podido cargar los datos");
  });

  test("skills and subagents join what was started with what was spent", () => {
    // A skill loaded but never attributed, and one attributed but never loaded, both listed.
    expect(skillRows(report()).map((s) => [s.name, s.loads, !!s.line])).toEqual([
      ["flow", 0, true],
      ["drillme-clarify", 2, false],
    ]);
    expect(subagentRows(report())).toMatchObject([
      { name: "Explore", count: 4, models: "haiku ×3, hereda ×1" },
    ]);
  });

  test("with every model priced, the note still says the cost is not a bill", async () => {
    const html = await render(report({ unpriced: [] }), { tab: "salud" });
    expect(html).toMatch(/role="note".*?Coste equivalente en la API.*?no se cobra por token/s);
    expect(html).not.toContain("Sin precio, fuera del coste");
  });

  test("a ticket picked in the URL opens with its link, the work with no ticket as none", async () => {
    const html = await render(report(), { ticket: "ABC-1033" });
    expect(html).toContain('href="/tickets/ABC-1033"');
    expect(html).toContain('aria-label="ABC-1033"');
    const none = await render(report(), { ticket: "none" });
    expect(none).toContain('aria-label="Sin ticket"');
    expect(none).not.toContain("Abrir ticket");
  });

  test("no prices counts in tokens, and a session shows its id's unique end", async () => {
    const html = await render(report({ total: line("total", { cost: null }) }));
    const health = await render(report({ total: line("total", { cost: null }) }), { tab: "salud" });
    expect(`${html}${health}`).toContain("Sin precios");
    expect(html).not.toContain("equivalente API ·");
    // The full id stays in the title; the visible part is its end, where UUIDv7 ids differ.
    expect(html).toContain("Codex 00beef");
  });

  test("Jira not configured leaves the keys and says why", async () => {
    const html = await render(report(), WEEK, { disabled: true });
    expect(html).toContain("Jira no está configurado");
    expect(html).not.toContain("Login roto");
  });

  test("a failed read of some transcripts is said, not hidden", async () => {
    const html = await render(
      report({ ingest: { lastRunAt: null, ms: 1, files: 1, errors: ["/x.jsonl: boom"] } }),
      { tab: "salud" },
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("/x.jsonl: boom");
  });

  test("an empty range says so instead of an empty ledger", async () => {
    const html = await render(
      report({ total: line("total", { calls: 0, cost: 0 }), byTicket: [], tickets: {} }),
    );
    expect(html).toContain("Sin llamadas en este periodo.");
  });
});

test("token counts in k and M", () => {
  expect([tokenText(950), tokenText(12_345), tokenText(1_585_200_000)]).toEqual([
    "950",
    "12,3 k",
    "1585,2 M",
  ]);
});
