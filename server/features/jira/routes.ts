import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type Cached, cached } from "../../cache.ts";
import type { Deps } from "../../deps.ts";
import { oauthPage as page } from "../../oauth.ts";
import { ProviderError } from "../../provider-error.ts";
import { ISSUE_KEY } from "./client.ts";
import {
  addReviewer,
  type BoardConfig,
  boardIssuesJql,
  getIssue,
  myOpenIssuesJql,
  searchAllIssues,
  teamOpenIssuesJql,
} from "./issues.ts";
import {
  authorizeUrl,
  consumeState,
  createState,
  exchangeCode,
  fetchMyself,
  listResources,
  pickJiraResource,
  saveConnection,
} from "./oauth.ts";

const COOKIE = "aos_oauth_state";

// The origin that can finish a login, or null when this server is it. Atlassian accepts only
// the callback registered in its app, and shows its own error page for any other.
export function loginOrigin(config: Deps["config"]): string | null {
  if (!config.jira) return null;
  const url = new URL(config.jira.callbackUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return port === config.port ? null : url.origin;
}

export function jiraAuthRoutes({ config, db }: Deps, tickets: Pick<TicketLoader, "invalidate">) {
  const redirectUri =
    config.jira?.callbackUrl ?? `http://localhost:${config.port}/auth/atlassian/callback`;
  return new Hono()
    .get("/start", async (c) => {
      const origin = loginOrigin(config);
      if (origin)
        return page(
          "Jira se conecta desde otro servidor",
          `Atlassian solo devuelve el login a ${config.jira?.callbackUrl}.\nEste servidor escucha en el puerto ${config.port}, así que el login no podría volver aquí.\nConecta Jira desde ${origin}.`,
          409,
          { href: `${origin}/`, label: `Abrir ${origin}` },
        );
      const state = createState(`http://${c.req.header("host")}/`);
      setCookie(c, COOKIE, state, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/auth/atlassian",
        maxAge: 600,
      });
      return c.redirect(await authorizeUrl(state, redirectUri));
    })
    .get("/callback", async (c) => {
      const error = c.req.query("error");
      if (error)
        return page(
          "Atlassian rechazó la autorización",
          `${error}\n${c.req.query("error_description") ?? ""}`,
        );
      const verdict = consumeState(c.req.query("state"), getCookie(c, COOKIE));
      deleteCookie(c, COOKIE, { path: "/auth/atlassian" });
      if (!verdict.ok) return page("Estado OAuth inválido", verdict.reason);
      const code = c.req.query("code");
      if (!code) return page("Falta el código de autorización", "code missing");
      if (!config.jira) return page("Falta configuración", "data/config.json has no jira.site");

      // A browser lands here: a failure is a page in the user's tab, never a JSON body.
      try {
        const tokens = await exchangeCode(code, redirectUri);
        const resources = await listResources(tokens.accessToken);
        const resource = pickJiraResource(resources, config.jira.site);
        if (!resource) {
          const seen = resources.map((r) => `${r.url} [${r.scopes.join(", ")}]`).join("\n");
          return page(`Sin acceso Jira a ${config.jira.site}`, seen || "(no resources)", 409);
        }
        const me = await fetchMyself(tokens.accessToken, resource.id);
        saveConnection(db, {
          accountId: me.accountId,
          displayName: me.displayName,
          siteUrl: resource.url,
          cloudId: resource.id,
          scopes: tokens.scope,
        });
        tickets.invalidate();
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        return page("Jira no respondió", err.message, 502);
      }
      return c.redirect(verdict.returnTo);
    });
}

export const TICKETS_TTL_MS = 60_000;

// What the ticket lists read with: the config and the one Jira client.
// From Deps, not Services: deps.ts builds the loaders, so Services cannot name them.
type Jira = Required<Pick<Deps, "config" | "jira">>;

function myTickets({ config, jira }: Jira) {
  return async () => {
    if (!config.jira) return { disabled: true as const };
    const jql = myOpenIssuesJql(config.jira.project);
    return { jql, tickets: await searchAllIssues(jira, config.jira, jql) };
  };
}
type Tickets = Awaited<ReturnType<ReturnType<typeof myTickets>>>;

// The whole team's open tickets, and who the user is among them.
function teamTickets({ config, jira }: Jira) {
  return async () => {
    if (!config.jira) return { disabled: true as const };
    const jql = teamOpenIssuesJql(config.jira.project);
    const tickets = await searchAllIssues(jira, config.jira, jql);
    return { jql, tickets, me: jira.connection()?.accountId ?? null };
  };
}
type Team = Awaited<ReturnType<ReturnType<typeof teamTickets>>>;

// A list of tickets, kept 60 s so a page load or a second tab costs no Jira search; the
// server's own check and the browser's refetch after a push share one search (see cache.ts).
// The disabled answer (no Jira configured) is never kept. With `onChange`, a read past the TTL
// answers the kept list at once and searches again behind it.
function keptLoader<T extends object>(
  search: () => Promise<T>,
  now?: () => number,
  onChange?: () => void,
) {
  return cached(search, { ttlMs: TICKETS_TTL_MS, keep: (v) => !("disabled" in v), now, onChange });
}

// My open tickets. `invalidate()` also drops a load started before a new Jira connection.
export function ticketLoader(
  deps: Jira,
  opts: { search?: () => Promise<Tickets>; now?: () => number } = {},
) {
  return keptLoader(opts.search ?? myTickets(deps), opts.now);
}

// The same, for the whole team's tickets. Its paged search took 2-3 s, so past the TTL a page
// gets the kept list and `onChange` (a `tickets` push) brings the new one.
export const teamLoader = (
  deps: Jira,
  opts: { search?: () => Promise<Team>; now?: () => number; onChange?: () => void } = {},
) => keptLoader(opts.search ?? teamTickets(deps), opts.now, opts.onChange);

// The boards the Tickets page shows. Without any configured, one board of every open ticket,
// whose columns are its statuses (`columns: null`).
type PageBoard = { id: string; name: string; columns: BoardConfig["columns"] | null };
export function pageBoards(jira: NonNullable<Deps["config"]["jira"]>) {
  const all: (PageBoard & { jql: string })[] = jira.boards.map((b) => ({
    id: b.id,
    name: b.name,
    columns: b.columns,
    jql: boardIssuesJql(jira.project, b),
  }));
  return all.length > 0
    ? all
    : [{ id: "open", name: "Abiertos", columns: null, jql: teamOpenIssuesJql(jira.project) }];
}

// One board's tickets, the board itself, the others to switch to, and who the user is.
function boardTickets({ config, jira }: Jira, id: string) {
  return async () => {
    if (!config.jira) return { disabled: true as const };
    const boards = pageBoards(config.jira);
    const board = boards.find((b) => b.id === id);
    if (!board) throw new Error(`No board ${id} in data/config.json`);
    const tickets = await searchAllIssues(jira, config.jira, board.jql);
    return {
      board: { id: board.id, name: board.name, columns: board.columns },
      boards: boards.map((b) => ({ id: b.id, name: b.name })),
      jql: board.jql,
      tickets,
      me: jira.connection()?.accountId ?? null,
    };
  };
}
type BoardTickets = Awaited<ReturnType<ReturnType<typeof boardTickets>>>;

// Each board's tickets, kept like the lists above, one kept list per board.
export function boardLoader(
  deps: Jira,
  opts: { search?: (id: string) => () => Promise<BoardTickets> } = {},
) {
  const search = opts.search ?? ((id: string) => boardTickets(deps, id));
  const loaders = new Map<string, Cached<BoardTickets>>();
  // The board asked for, the first one when none is, or null when there is no such board.
  // Without Jira any id passes: its search answers `disabled`.
  const pick = (id: string | undefined): string | null => {
    if (!deps.config.jira) return id ?? "open";
    const all = pageBoards(deps.config.jira);
    if (id === undefined) return all[0]?.id ?? null;
    return all.some((b) => b.id === id) ? id : null;
  };
  const load = (id: string, o: { fresh?: boolean } = {}) => {
    let l = loaders.get(id);
    if (!l) {
      l = keptLoader(search(id));
      loaders.set(id, l);
    }
    return l.get(o);
  };
  const invalidate = () => {
    for (const l of loaders.values()) l.invalidate();
  };
  return { pick, load, invalidate };
}
export type BoardLoader = ReturnType<typeof boardLoader>;

export type TicketLoader = ReturnType<typeof ticketLoader>;
export type TeamLoader = ReturnType<typeof teamLoader>;

export function ticketRoutes(
  deps: Jira,
  tickets: TicketLoader,
  team: TeamLoader,
  boards: BoardLoader,
) {
  const { jira } = deps;
  return (
    new Hono()
      // `?fresh=1`: the user asked for the list now ("Actualizar"), so skip the kept one.
      .get("/", async (c) => c.json(await tickets.get({ fresh: c.req.query("fresh") === "1" })))
      .get("/team", async (c) => c.json(await team.get({ fresh: c.req.query("fresh") === "1" })))
      // `?id=`: one board of data/config.json; without it, the first.
      .get("/board", async (c) => {
        const id = boards.pick(c.req.query("id"));
        if (id === null) return c.json({ error: "unknown_board" }, 404);
        return c.json(await boards.load(id, { fresh: c.req.query("fresh") === "1" }));
      })
      .get("/:key", async (c) => {
        const key = c.req.param("key").toUpperCase();
        if (!ISSUE_KEY.test(key)) return c.json({ error: "invalid_key" }, 400);
        if (!deps.config.jira) return c.json({ disabled: true as const });
        return c.json(await getIssue(jira, deps.config, key));
      })
      // Adds the user to the ticket's reviewers, keeping the others. Both lists show it at once.
      .post("/:key/reviewer", async (c) => {
        const key = c.req.param("key").toUpperCase();
        if (!ISSUE_KEY.test(key)) return c.json({ error: "invalid_key" }, 400);
        if (!deps.config.jira) return c.json({ disabled: true as const });
        const added = await addReviewer(jira, deps.config.jira, key);
        tickets.invalidate();
        team.invalidate();
        boards.invalidate();
        return c.json({ key, reviewer: added.accountId });
      })
  );
}
