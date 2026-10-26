import { describe, expect, test } from "bun:test";
import type { AgentsSnapshot } from "../../../server/features/monitor/monitor.ts";
import { failQuery, renderWith } from "../../test-render.tsx";
import { projects } from "../projects/test-fixtures.ts";
import { writeMembership } from "../terminals/mesas.ts";
import type { TerminalInfo } from "../terminals/queries.ts";
import { terminal } from "../terminals/test-fixtures.ts";
import { AgentsPage, type AgentsSearch } from "./page.tsx";
import {
  activityOptions,
  agentState,
  agentsOptions,
  countAgents,
  cpuText,
  duration,
  memText,
  sortAgents,
} from "./queries.ts";

const snapshot = (over: Partial<AgentsSnapshot> = {}): AgentsSnapshot => ({
  app: [],
  outside: [],
  missing: [],
  ...over,
});

const render = (
  search: AgentsSearch,
  terminals: TerminalInfo[],
  agents: AgentsSnapshot | undefined = snapshot(),
) =>
  renderWith(<AgentsPage search={search} />, [
    [["projects"], projects()],
    [["terminals"], { terminals, locations: [] }],
    ...(agents ? [[["agents"], agents] as [unknown[], unknown]] : []),
  ]);

// A terminal's card or lane: the list items that carry its Ver link, in either view.
const rows = (html: string) =>
  html
    .split("<li")
    .slice(1)
    .map((li) => li.slice(0, li.indexOf("</li>")))
    .filter((li) => li.includes('aria-label="Ver '));

describe("agent state", () => {
  test("an ended terminal says how it ended, never that it waits", () => {
    expect(agentState(terminal({ state: "exited", activity: "idle" }), "idle")).toMatchObject({
      bucket: "ended",
      label: "terminada",
    });
    expect(agentState(terminal({ state: "lost" }), null)).toMatchObject({
      bucket: "failed",
      label: "perdida",
    });
    expect(agentState(terminal({ state: "failed" }), null).bucket).toBe("failed");
  });

  test("Claude's own word wins over its output", () => {
    const busy = terminal({ activity: "busy" });
    expect(agentState(busy, "waiting")).toMatchObject({ bucket: "waiting", label: "esperándote" });
    expect(agentState(terminal({ activity: "idle" }), "busy")).toMatchObject({
      bucket: "working",
      label: "trabajando",
    });
    // A word never seen leaves it to the output.
    expect(agentState(busy, "shell").bucket).toBe("working");
  });

  test("without a word the output decides, and an untracked harness has no data", () => {
    expect(agentState(terminal({ harness: "shell", activity: "busy" }), null).bucket).toBe(
      "working",
    );
    expect(agentState(terminal({ harness: "shell", activity: "idle" }), null)).toMatchObject({
      bucket: "waiting",
      label: "en espera",
    });
    expect(agentState(terminal({ harness: "grok", activity: null }), null)).toMatchObject({
      bucket: "unknown",
      label: "sin dato de actividad",
    });
  });
});

describe("agent order and counts", () => {
  const list = [
    terminal({ id: "ended", state: "exited", startedAt: "2026-10-02T12:00:00Z" }),
    terminal({ id: "idle-old", activity: "idle", startedAt: "2026-10-02T08:00:00Z" }),
    terminal({ id: "busy", activity: "busy", startedAt: "2026-10-02T07:00:00Z" }),
    terminal({ id: "idle-new", activity: "idle", startedAt: "2026-10-02T09:00:00Z" }),
    terminal({ id: "lost", state: "lost" }),
    terminal({ id: "grok", harness: "grok", activity: null }),
  ];

  test("working first, then waiting, unknown, failed and ended; the newest first in each", () => {
    expect(sortAgents(list, () => null).map((t) => t.id)).toEqual([
      "busy",
      "idle-new",
      "idle-old",
      "grok",
      "lost",
      "ended",
    ]);
  });

  test("ties keep one order whatever the input order", () => {
    const twins = [terminal({ id: "b" }), terminal({ id: "a" })];
    const ids = (l: TerminalInfo[]) => sortAgents(l, () => null).map((t) => t.id);
    expect(ids(twins)).toEqual(["a", "b"]);
    expect(ids([...twins].reverse())).toEqual(["a", "b"]);
  });

  test("Claude's word moves a terminal between buckets", () => {
    const status = (t: TerminalInfo) => (t.id === "idle-old" ? "busy" : null);
    expect(countAgents(list, status)).toEqual({
      working: 2,
      waiting: 1,
      unknown: 1,
      failed: 1,
      ended: 1,
    });
  });

  test("durations, CPU and memory read the Spanish way", () => {
    expect([45_000, 12 * 60_000, (2 * 60 + 5) * 60_000, -5].map(duration)).toEqual([
      "45 s",
      "12 min",
      "2 h 5 min",
      "0 s",
    ]);
    expect(cpuText(12.5)).toBe("12,5 % CPU");
    expect(memText(300_000)).toBe("293 MB");
    expect(memText(1_572_864)).toBe("1,5 GB");
  });
});

describe("agents page", () => {
  const sh = terminal({
    id: "sh",
    harness: "shell",
    location: "repo:alpha",
    cwd: "/src/alpha",
    activity: "busy",
    lastOutputAt: "2026-10-02T10:00:00Z",
  });
  const cl = terminal({
    id: "cl",
    harness: "claude",
    location: "wt:alpha:fix",
    cwd: "/wt/alpha/fix",
  });
  const done = terminal({
    id: "done",
    harness: "codex",
    state: "exited",
    endedAt: "2026-10-01T08:12:00Z",
  });

  test("rows show state, place, usage, the shell's last line and the right actions", async () => {
    const html = await render(
      {},
      [done, cl, sh],
      snapshot({
        app: [
          {
            id: "sh",
            cpu: 40.5,
            rssKb: 5000,
            lastLine: "building 3/9",
            status: null,
            lastOutputAt: null,
          },
          {
            id: "cl",
            cpu: 15,
            rssKb: 320_000,
            lastLine: null,
            status: "waiting",
            lastOutputAt: null,
          },
        ],
      }),
    );
    // One column per state, the ones waiting for the user first.
    const [second, first, third] = rows(html);
    expect(first).toContain("Shell");
    expect(first).toContain("trabajando");
    expect(first).toContain("40,5 % CPU");
    expect(first).toContain("building 3/9");
    expect(first).toContain("última salida");
    expect(first).toContain('aria-label="Parar Shell en src/alpha"');
    expect(second).toContain("esperándote");
    expect(second).toContain("313 MB");
    expect(third).toContain("terminada");
    expect(third).toContain("duró 12 min");
    expect(third).toContain('aria-label="Quitar Codex en work/repo"');
    expect(third).not.toContain("CPU");
    expect(html).toContain("1 trabajando · 1 en espera · 1 terminada · 0 fallidas");
  });

  test("a terminal the snapshot has not reached yet shows a dash, not zero", async () => {
    const [row] = rows(await render({}, [sh], snapshot()));
    expect(row).toMatch(/>— · lleva /);
    expect(row).not.toContain("CPU");
  });

  test("Ver opens the tree node in the Mesa with the terminal as a tile; a terminal whose place is gone opens under the app", async () => {
    const orphan = terminal({ id: "orphan", location: "wt:alpha:gone", cwd: "/wt/alpha/gone" });
    const html = await render({}, [cl, orphan]);
    expect(html).toContain('href="/terminales?mesa=mesa-1&amp;t=cl&amp;node=wt%3Aalpha%3Afix"');
    expect(html).toContain('href="/terminales?mesa=mesa-1&amp;t=orphan&amp;node=app"');
  });

  test("the filters narrow the list and say how many are left", async () => {
    const byHarness = await render({ h: "shell" }, [sh, cl, done]);
    expect(rows(byHarness)).toHaveLength(1);
    expect(byHarness).toContain("1 de 3");
    const byProject = await render({ p: "wt:alpha:fix" }, [sh, cl, done]);
    expect(rows(byProject)).toHaveLength(1);
    expect(rows(byProject)[0]).toContain("Claude");
    const none = await render({ h: "grok" }, [sh]);
    expect(none).toContain("Ninguna terminal coincide con el filtro.");
  });

  test("a full grid disables the button for a terminal not already in it", async () => {
    const grid = (ids: string[]) =>
      writeMembership(() => ({
        version: 1,
        activeId: "mesa-1",
        mesas: [{ id: "mesa-1", name: "Mesa 1", ids, layout: null }],
      }));
    try {
      grid(["1", "2", "3", "4", "5", "6"]);
      const html = await render({}, [sh]);
      expect(html).toMatch(
        /<button[^>]*disabled=""[^>]*title="La cuadrícula ya tiene 6 terminales"/,
      );
      grid(["1", "2", "3", "4", "5", "sh"]);
      expect(await render({}, [sh])).not.toContain('disabled=""');
    } finally {
      grid([]);
    }
  });

  test("the header counts only terminals it has read, and a failed project read is said", async () => {
    const counts = /\d+ trabajando/;
    const loading = await renderWith(<AgentsPage search={{}} />, [[["projects"], projects()]]);
    expect(loading).not.toMatch(counts);
    const failed = await renderWith(
      <AgentsPage search={{}} />,
      [[["projects"], projects()]],
      failQuery(["terminals"], undefined, "host down"),
    );
    expect(failed).not.toMatch(counts);
    expect(failed).toContain("host down");
    // Without the projects no terminal has a place: a project filter cannot say "none match".
    const noPlaces = await renderWith(
      <AgentsPage search={{ p: "wt:alpha:fix" }} />,
      [[["terminals"], { terminals: [sh, cl], locations: [] }]],
      failQuery(["projects"], undefined, "envs slow"),
    );
    expect(noPlaces).not.toContain("Ninguna terminal coincide con el filtro.");
    expect(noPlaces).toContain("Sin proyectos, el filtro por proyecto no se aplica: envs slow");
    // Projects still loading: no place is known yet, so nothing can be said not to match.
    const placing = await renderWith(<AgentsPage search={{ p: "wt:alpha:fix" }} />, [
      [["terminals"], { terminals: [sh, cl], locations: [] }],
    ]);
    expect(placing).not.toContain("Ninguna terminal coincide con el filtro.");
  });

  test("a failed snapshot keeps the rows and says what is missing", async () => {
    const html = await renderWith(
      <AgentsPage search={{}} />,
      [
        [["projects"], projects()],
        [["terminals"], { terminals: [sh], locations: [] }],
      ],
      (client) => {
        client
          .getQueryCache()
          .build(client, { queryKey: ["agents"] })
          .setState({
            status: "error",
            error: new Error("ps failed"),
            fetchStatus: "idle",
          });
      },
    );
    expect(rows(html)).toHaveLength(1);
    expect(html).toContain("Sin consumo ni último estado: ps failed");
  });

  test("sessions outside the app show their usage and who has no data", async () => {
    const html = await render(
      {},
      [],
      snapshot({
        outside: [
          {
            harness: "claude",
            id: "s-1",
            cwd: "/src/other",
            name: null,
            pid: 601,
            state: "activa",
            status: "busy",
            startedAt: null,
            updatedAt: null,
            cpu: 1,
            rssKb: 1024,
          } as AgentsSnapshot["outside"][number],
        ],
        missing: ["grok"],
      }),
    );
    expect(html).toContain("Ninguna terminal abierta en la app.");
    expect(html).toContain("src/other</span>");
    expect(html).toContain(">1 % CPU · 1 MB</span>");
    expect(html).toContain("Sin datos de Grok.");
  });
});

describe("agents page views and activity", () => {
  const cl = terminal({
    id: "cl",
    harness: "claude",
    location: "wt:alpha:fix",
    cwd: "/wt/alpha/fix",
    activity: "busy",
  });
  const sh = terminal({ id: "sh", harness: "shell", location: "repo:alpha", cwd: "/src/alpha" });
  const bars = Array.from({ length: 24 }, (_, i) => (i === 23 ? 2 : i === 0 ? 1 : 0));
  const activity = { to: "2026-10-06T10:00:00.000Z", slotMs: 300_000, calls: { cl: bars } };
  const page = (search: AgentsSearch, extra: [unknown[], unknown][] = []) =>
    renderWith(<AgentsPage search={search} />, [
      [["projects"], projects()],
      [["terminals"], { terminals: [cl, sh], locations: [] }],
      [["agents"], snapshot()],
      ...extra,
    ]);

  test("by state is the default view, and the toggle says which one is on", async () => {
    const html = await page({});
    expect(html).toMatch(/aria-pressed="true"[^>]*>Por estado</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Carriles</);
    expect(html).toContain('aria-label="Te esperan"');
    const lanes = await page({ v: "carriles" });
    expect(lanes).toMatch(/aria-pressed="true"[^>]*>Carriles</);
    expect(lanes).not.toContain('aria-label="Te esperan"');
  });

  test("the lanes carry the same rows, facts and actions as the board", async () => {
    const html = await page({ v: "carriles" });
    const lanes = rows(html);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toContain("trabajando");
    expect(lanes[0]).toContain('aria-label="Parar Claude en alpha/fix"');
    expect(html).toContain("ahora");
  });

  test("an agent with model calls shows its bars and their count; one without shows its span", async () => {
    const html = await page({}, [[["agents-activity"], activity]]);
    const [claude] = rows(html).filter((r) => r.includes("Claude"));
    const [shell] = rows(html).filter((r) => r.includes("Shell"));
    expect(claude).toContain("3 llamadas · 2 h");
    expect(shell).toContain("últimas 2 h");
    expect(html).not.toContain("Sin llamadas al modelo");
  });

  test("a failed activity read says so and the strips fall back to the span, never to zero", async () => {
    const html = await renderWith(
      <AgentsPage search={{}} />,
      [
        [["projects"], projects()],
        [["terminals"], { terminals: [cl], locations: [] }],
        [["agents"], snapshot()],
      ],
      (client) => {
        client
          .getQueryCache()
          .build(client, { queryKey: ["agents-activity"] })
          .setState({ status: "error", error: new Error("ingest failed"), fetchStatus: "idle" });
      },
    );
    expect(html).toContain(
      "Sin llamadas al modelo; cada tira muestra solo cuándo escribió: ingest failed",
    );
    expect(rows(html)[0]).toContain("últimas 2 h");
    expect(rows(html)[0]).not.toContain("llamadas · 2 h");
  });
});

// The interval while reads answer, then while they fail.
const pace = (every: unknown) =>
  ["success", "error"].map((status) =>
    (every as (q: { state: { status: string } }) => number)({ state: { status } }),
  );

test("the model calls are read every 30 s and keep TanStack's pause while hidden", () => {
  expect(pace(activityOptions.refetchInterval)).toEqual([30_000, 180_000]);
  expect(activityOptions).not.toHaveProperty("refetchIntervalInBackground");
});

// Bun has no `window`, so TanStack runs as on a server and never starts the interval: the
// pause while the tab is hidden is proven by the e2e (0 requests on a hidden page). Here only
// that nothing turns it off.
test("the snapshot is read every 5 s and keeps TanStack's pause while hidden", () => {
  expect(pace(agentsOptions.refetchInterval)).toEqual([5000, 30_000]);
  expect(agentsOptions).not.toHaveProperty("refetchIntervalInBackground");
});
