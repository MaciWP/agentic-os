import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  Outlet,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import { lazy } from "react";
import { ISSUE_KEY } from "../shared/envs.ts";
import { GOAL_KEY } from "../shared/objectives.ts";
import { RouteCrash } from "./crash.tsx";
import { InicioPage } from "./features/home/page.tsx";
import type { DocsSearch } from "./features/memory/desk-model.ts";
import type { AgentsSearch } from "./features/monitor/page.tsx";
import type { GridSearch } from "./features/terminals/grid.tsx";
import { mesaSearch } from "./features/terminals/mesas.ts";
import { usePhone } from "./features/terminals/mobile.tsx";
import type { TicketsSearch } from "./features/tickets/board.tsx";
import { USAGE_TABS, type UsageSearch, type UsageTab } from "./features/usage/queries.ts";
import { Shell } from "./shell.tsx";

// Inicio is the landing page and ships in the first chunk; every other page loads on its first
// visit, so the dashboard opens without the Mesa, Consumo or the docs editor. A page passed
// through `lazy` suspends inside its own route (`wrapInSuspense`), so the Shell never blinks.
const GridPage = lazy(() =>
  import("./features/terminals/grid.tsx").then((m) => ({ default: m.GridPage })),
);
const PhoneTerminals = lazy(() =>
  import("./features/terminals/phone-list.tsx").then((m) => ({ default: m.PhoneTerminals })),
);
const AgentsPage = lazy(() =>
  import("./features/monitor/page.tsx").then((m) => ({ default: m.AgentsPage })),
);
const UsagePage = lazy(() =>
  import("./features/usage/page.tsx").then((m) => ({ default: m.UsagePage })),
);
const NotesDesk = lazy(() =>
  import("./features/memory/desk.tsx").then((m) => ({ default: m.NotesDesk })),
);

const TicketsPage = lazyRouteComponent(() => import("./features/tickets/page.tsx"), "TicketsPage");

const rootRoute = createRootRoute({ component: Outlet });
// Terminal windows stand alone; every other page lives inside the Shell.
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: Shell });
const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terminal/$id",
  // xterm is loaded only by a terminal window, never by the dashboard.
  component: lazyRouteComponent(
    () => import("./features/terminals/terminal-page.tsx"),
    "TerminalWindow",
  ),
});
const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: InicioPage,
});
// «Hoy» merged into Inicio (2026-10-14); old links still land.
const todayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/hoy",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
// `w`, whose tickets the board shows, and `b`, which Jira board, on the board and on an open
// ticket alike, so opening a teammate's ticket keeps their board.
const ticketsSearch = (search: Record<string, unknown>): TicketsSearch => ({
  ...(typeof search.w === "string" && search.w ? { w: search.w } : {}),
  ...(typeof search.b === "string" && search.b ? { b: search.b } : {}),
});
const ticketsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tickets",
  component: TicketsPage,
  validateSearch: ticketsSearch,
});
const ticketRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tickets/$key",
  component: TicketsPage,
  validateSearch: ticketsSearch,
});
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
// The projects page lives in the Mesa now; old links and bookmarks land there with their node
// marked in the tree and their terminal as a tile. Its tabs are gone, so `tab` goes.
const projectsRedirect = createRoute({
  getParentRoute: () => appRoute,
  path: "/proyectos",
  beforeLoad: ({ search }: { search: Record<string, unknown> }) => {
    throw redirect({
      to: "/terminales",
      search: mesaSearch({ node: text(search.node), t: text(search.t) }),
      replace: true,
    });
  },
});
// Which terminals, and the one shown alone; ids are UUIDs, so a comma joins them.
const gridRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/terminales",
  validateSearch: (search: Record<string, unknown>): GridSearch => ({
    mesa: text(search.mesa),
    t: text(search.t),
    ids: typeof search.ids === "string" ? search.ids : undefined,
    max: text(search.max),
    node: text(search.node),
    view: search.view === "mosaico" || search.view === "lienzo" ? search.view : undefined,
  }),
  wrapInSuspense: true,
  // A phone gets the list and each terminal's own page; a Mesa it asks for by name stays.
  component: function Grid() {
    const search = gridRoute.useSearch();
    const phone = usePhone();
    if (phone && search.t) return <Navigate to="/terminal/$id" params={{ id: search.t }} replace />;
    if (phone && !search.mesa && !search.ids && !search.node) return <PhoneTerminals />;
    return <GridPage search={search} />;
  },
});
// The filters and the view ride in the search string, so a reload keeps them.
const agentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agentes",
  validateSearch: (search: Record<string, unknown>): AgentsSearch => {
    const h = text(search.h);
    const p = text(search.p);
    return {
      ...(h && { h }),
      ...(p && { p }),
      ...(search.v === "carriles" && { v: "carriles" as const }),
      ...(["consultas", "mensajes", "reservas"].includes(String(search.s)) && {
        s: search.s as AgentsSearch["s"],
      }),
      ...(text(search.a) && { a: text(search.a) }),
    };
  },
  wrapInSuspense: true,
  component: function Agents() {
    return <AgentsPage search={agentsRoute.useSearch()} />;
  },
});
// The period and the tab ride in the search string, so a reload or a shared link keeps them; an
// old link's dates are dropped and it opens on the current week.
const usageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/consumo",
  validateSearch: (search: Record<string, unknown>): UsageSearch => {
    const offset = Number(search.offset);
    const ticket = text(search.ticket);
    return {
      ...(search.kind === "month" && { kind: "month" as const }),
      ...(Number.isInteger(offset) && offset > 0 && offset <= 120 && { offset }),
      ...(ticket &&
        (ticket === "none" || ISSUE_KEY.test(ticket) || GOAL_KEY.test(ticket)) && { ticket }),
      ...(search.tab !== "gasto" &&
        USAGE_TABS.includes(search.tab as UsageTab) && { tab: search.tab as UsageTab }),
    };
  },
  wrapInSuspense: true,
  component: function Usage() {
    return <UsagePage search={usageRoute.useSearch()} />;
  },
});
// The open note, the search and the grouping ride in the search string: harness ids hold
// slashes, and a reload must reopen the same view.
const docsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/docs",
  validateSearch: (search: Record<string, unknown>): DocsSearch => ({
    ...(text(search.id) && { id: text(search.id) }),
    ...(text(search.q) && { q: text(search.q) }),
    ...(search.v === "dia" && { v: "dia" as const }),
  }),
  wrapInSuspense: true,
  component: function Docs() {
    return <NotesDesk search={docsRoute.useSearch()} />;
  },
});
// A page whose code throws shows RouteCrash in its place; the Shell and the other pages stay.
export const router = createRouter({
  defaultErrorComponent: RouteCrash,
  routeTree: rootRoute.addChildren([
    appRoute.addChildren([
      homeRoute,
      todayRoute,
      projectsRedirect,
      gridRoute,
      agentsRoute,
      usageRoute,
      ticketsRoute,
      ticketRoute,
      docsRoute,
    ]),
    terminalRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}
