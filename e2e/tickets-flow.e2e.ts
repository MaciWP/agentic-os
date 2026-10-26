import { expect, type Page, type Route, test } from "@playwright/test";
import { noClippedControls } from "./helpers.ts";

// The Flujo board on synthetic tickets: Jira and GitHub are answered by the browser, so no
// write ever leaves it. Any other write to a reviewer route is aborted and fails the test.
const EVIDENCE = "data/evidence/tickets-flow";

const me = { accountId: "u-me", displayName: "Yo Mismo" };
const ana = { accountId: "u-ana", displayName: "Ana Ruiz" };
const bea = { accountId: "u-bea", displayName: "Bea Soto" };

// Status ids: the board's columns match tickets by id, as Jira's do.
const STATUS_IDS: Record<string, string> = {
  QUÉ: "20002",
  BORRADOR: "20001",
  "En curso": "3",
  "Pull Request": "20004",
  "In Product Review": "20005",
};
const ticket = (key: string, status: string, over: Record<string, unknown> = {}) => ({
  key,
  summary: `Resumen de ${key}`,
  status: { id: STATUS_IDS[status] ?? "0", name: status, category: "indeterminate" },
  issuetype: "Task",
  assignee: null,
  parent: null,
  priority: null,
  labels: [],
  points: null,
  size: null,
  reviewers: [],
  updated: "2026-10-03T08:00:00Z",
  url: `https://jira.example.test/browse/${key}`,
  descriptionAdf: null,
  descriptionMd: "",
  acceptanceCriteria: [],
  ...over,
});

const pr = (n: number, title: string) => ({
  repo: "api",
  number: n,
  title,
  url: `https://github.com/acme/api/pull/${n}`,
  author: "ana",
  draft: false,
  updatedAt: "2026-10-03T08:00:00Z",
  kind: "open",
});

// The board's columns: the sections that head their tickets with a title.
const columns = (page: Page) => page.locator("section[aria-label]:has(> h2)");

// The answers, and every write the page sent. GitHub fails until `github.ok` turns true.
function fakeProviders(page: Page) {
  const writes: string[] = [];
  const state = { jiraTaken: false, githubOk: false };
  const mine = [ticket("ABC-1", "QUÉ", { assignee: me })];
  const team = () => [
    ...mine,
    ticket("ABC-2", "In Product Review", {
      assignee: ana,
      reviewers: state.jiraTaken ? [bea, me] : [bea],
    }),
    ticket("ABC-3", "Pull Request", { assignee: ana }),
    ticket("ABC-4", "QUÉ"),
  ];
  const boards = [
    { id: "sprint", name: "Sprint" },
    { id: "refinamiento", name: "Refinamiento" },
  ];
  const column = (name: string, ...statuses: string[]) => ({ name, statuses });
  const board = (id: string | null) =>
    id === "refinamiento"
      ? {
          board: {
            id: "refinamiento",
            name: "Refinamiento",
            columns: [column("BORRADOR", "20001"), column("QUÉ", "20002")],
          },
          boards,
          jql: "j",
          tickets: [ticket("ABC-5", "BORRADOR", { assignee: ana })],
          me: me.accountId,
        }
      : {
          board: {
            id: "sprint",
            name: "Sprint",
            columns: [
              column("TO DO", "20002", "20001"),
              column("IN PROGRESS", "3"),
              column("PULL REQUEST", "20004"),
              column("PRODUCT REVIEW", "20005"),
            ],
          },
          boards,
          jql: "j",
          tickets: team(),
          me: me.accountId,
        };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  const handle = async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== "GET") {
      writes.push(`${req.method()} ${path}`);
      if (path === "/api/tickets/ABC-2/reviewer") {
        state.jiraTaken = true;
        return json(route, { key: "ABC-2", reviewer: me.accountId });
      }
      if (path === "/api/github/prs/api/4/reviewers")
        return state.githubOk
          ? json(route, { reviewer: "me" })
          : json(
              route,
              {
                error: "provider_error",
                provider: "github",
                status: 502,
                detail: "GitHub 502 on /repos/acme/api/pulls/4/requested_reviewers",
              },
              502,
            );
      return route.abort();
    }
    if (path === "/api/tickets") return json(route, { jql: "j", tickets: mine });
    if (path === "/api/tickets/board")
      return json(route, board(new URL(req.url()).searchParams.get("id")));
    const one = /^\/api\/tickets\/([A-Z]+-\d+)$/.exec(path)?.[1];
    if (one)
      return json(
        route,
        team().find((t) => t.key === one),
      );
    if (path === "/api/github/prs")
      return json(route, { prs: [pr(4, "ABC-2 export to CSV")], errors: [], repos: ["acme/api"] });
    return route.fallback();
  };
  return {
    writes,
    state,
    install: async () => {
      await page.route("**/api/tickets**", handle);
      await page.route("**/api/github/prs**", handle);
    },
  };
}

test("the Sprint board as Jira shows it, a teammate's ticket beside it, and «Revisar yo» that keeps what went through", async ({
  page,
}) => {
  const fake = fakeProviders(page);
  await fake.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tickets");
  const boardSwitch = page.getByRole("toolbar", { name: "Tablero" });
  await expect(boardSwitch.getByRole("button", { name: "Sprint" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const who = page.getByRole("toolbar", { name: "De quién" });
  await expect(who.getByRole("button", { name: /^Míos/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-ticket]")).toHaveCount(1);

  await who.getByRole("button", { name: /^Todo el equipo/ }).click();
  await expect(page).toHaveURL(/\/tickets\?w=all$/);
  await expect(page.locator("[data-ticket]")).toHaveCount(4);
  // The board's columns in its order, the empty ones too.
  await expect(columns(page)).toHaveText([
    /^TO DO/,
    /^IN PROGRESS/,
    /^PULL REQUEST/,
    /^PRODUCT REVIEW/,
  ]);
  await expect(
    page.getByRole("region", { name: "PULL REQUEST" }).locator('[data-ticket="ABC-3"]'),
  ).toBeVisible();

  // Refinamiento keeps whose tickets; the Sprint is one click back.
  await boardSwitch.getByRole("button", { name: "Refinamiento" }).click();
  await expect(page).toHaveURL(/\/tickets\?w=all&b=refinamiento$/);
  await expect(page.locator("[data-ticket]")).toHaveCount(1);
  await expect(columns(page)).toHaveText([/^BORRADOR/, /^QUÉ/]);
  await page.locator('[data-ticket="ABC-5"]').click();
  await expect(page).toHaveURL(/\/tickets\/ABC-5\?w=all&b=refinamiento$/);
  await page
    .getByRole("complementary", { name: "Ticket" })
    .getByRole("link", { name: "Cerrar" })
    .click();
  await boardSwitch.getByRole("button", { name: "Sprint" }).click();
  await expect(page).toHaveURL(/\/tickets\?w=all&b=sprint$/);
  await expect(page.locator("[data-ticket]")).toHaveCount(4);
  await expect(page.locator('[data-ticket="ABC-2"]')).toContainText("#4");
  await expect(page.locator('[data-ticket="ABC-4"]')).toContainText("Sin asignar");
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/team-1440.png` });

  await who.getByRole("button", { name: /^Ana/ }).click();
  await expect(page).toHaveURL(/\?w=u-ana&b=sprint$/);
  await expect(page.locator("[data-ticket]")).toHaveCount(2);
  await page.locator('[data-ticket="ABC-2"]').click();
  // The board keeps its filter beside the open ticket.
  await expect(page).toHaveURL(/\/tickets\/ABC-2\?w=u-ana&b=sprint$/);
  await expect(page.locator('[data-ticket="ABC-2"]')).toHaveAttribute("aria-current", "page");
  const panel = page.getByRole("complementary", { name: "Ticket" });
  await expect(panel.locator("#ticket-title")).toHaveText("Resumen de ABC-2");
  await expect(panel.getByRole("heading", { name: "Revisión" })).toBeVisible();

  // Asked first; cancelling writes nothing.
  const take = panel.getByRole("button", { name: "Revisar yo" });
  await take.click();
  const ask = panel.getByRole("group", { name: "Pasas a revisar ABC-2" });
  await expect(ask).toContainText("Bea Soto siguen");
  await expect(ask).toContainText("api#4");
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/ask-1440.png` });
  await ask.getByRole("button", { name: "Cancelar" }).click();
  await expect(ask).toHaveCount(0);
  expect(fake.writes).toEqual([]);

  // Jira goes through, GitHub fails: Jira stays done, GitHub says why and offers a retry.
  await take.click();
  await ask.getByRole("button", { name: "Confirmar" }).click();
  const steps = panel.getByRole("list", { name: "Revisión" });
  await expect(steps.getByRole("listitem").filter({ hasText: "ABC-2 en Jira" })).toContainText(
    "hecho",
  );
  const github = steps.getByRole("listitem").filter({ hasText: "api#4 en GitHub" });
  await expect(github).toContainText("falló");
  await expect(github).toContainText("GitHub 502");
  await expect(panel.getByRole("alert")).toContainText("No se hizo todo: api#4 en GitHub");
  await expect(panel.getByRole("alert")).toContainText("Lo que sí se hizo se queda");
  await expect(panel).toContainText("Tú, Bea Soto");
  expect(fake.writes).toEqual([
    "POST /api/tickets/ABC-2/reviewer",
    "POST /api/github/prs/api/4/reviewers",
  ]);
  await page.screenshot({ path: `${EVIDENCE}/partial-1440.png` });

  // The retry sends GitHub alone, never Jira again.
  fake.state.githubOk = true;
  await github.getByRole("button", { name: "Reintentar" }).click();
  await expect(github).toContainText("hecho");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(fake.writes.slice(2)).toEqual(["POST /api/github/prs/api/4/reviewers"]);

  await panel.getByRole("link", { name: "Cerrar" }).click();
  await expect(page).toHaveURL(/\/tickets\?w=u-ana&b=sprint$/);
});

test("a failed board read says so with a retry, never as an empty board", async ({ page }) => {
  await page.route("**/api/tickets**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/tickets/board")
      return route.fulfill({
        status: 502,
        json: { error: "provider_error", provider: "jira", status: 503, detail: "Jira 503" },
      });
    if (path === "/api/tickets")
      return route.fulfill({
        json: { jql: "j", tickets: [ticket("ABC-1", "QUÉ", { assignee: me })] },
      });
    return route.fallback();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tickets");
  await expect(page.getByRole("alert")).toContainText("Jira 503");
  await expect(page.getByRole("button", { name: "Reintentar" })).toBeVisible();
  await expect(page.locator("[data-ticket]")).toHaveCount(0);
  await noClippedControls(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await noClippedControls(page);
});

// «Empezar» and «Revisar a fondo» with the kickoff answered by the browser too: no env is
// created and no Claude starts. The page sends the right request and shows the step.
test("«Empezar» on the user's ticket and «Revisar a fondo» on a teammate's send one kickoff each and show its step", async ({
  page,
}) => {
  const fake = fakeProviders(page);
  await fake.install();
  const sent: unknown[] = [];
  const runs: Record<string, unknown>[] = [];
  await page.route("**/api/kickoff", (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: { kickoffs: runs } });
    const body = req.postDataJSON() as { key: string; mode: string };
    sent.push(body);
    const run = {
      ...body,
      step: "env",
      state: "running",
      error: null,
      warning: null,
      job: null,
      terminal: null,
      reused: false,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    runs.unshift(run);
    return route.fulfill({ status: 202, json: { kickoff: run } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/tickets/ABC-1");
  const panel = page.getByRole("complementary", { name: "Ticket" });
  const start = panel.getByRole("region", { name: "Arranque" });
  await start.getByRole("button", { name: "Empezar" }).click();
  await expect(start.getByRole("status")).toHaveText("preparando el entorno…");
  await expect(start.getByRole("button", { name: "Empezar" })).toBeDisabled();
  await expect(page.locator('[data-ticket="ABC-1"]')).toContainText("arrancando…");
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/kickoff-start.png` });
  // The manual launch is still there, folded.
  await expect(panel.getByRole("region", { name: "Lanzar agente" })).toBeHidden();

  // Nobody has ABC-4: it can be started, and taken for review.
  await page.goto("/tickets/ABC-4?w=all");
  await expect(panel.getByRole("button", { name: "Empezar" })).toBeVisible();

  await page.goto("/tickets/ABC-2?w=all");
  const review = panel.getByRole("region", { name: "Revisión" });
  await review.getByRole("button", { name: "Revisar a fondo" }).click();
  await expect(review.getByRole("status")).toHaveText("preparando el entorno…");
  expect(sent).toEqual([
    { key: "ABC-1", mode: "start" },
    { key: "ABC-2", mode: "review", prs: [{ repo: "api", number: 4 }] },
  ]);
  await page.screenshot({ path: `${EVIDENCE}/kickoff-review.png` });
  expect(fake.writes).toEqual([]);
});
