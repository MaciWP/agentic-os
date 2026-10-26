import { Link, useNavigate } from "@tanstack/react-router";
import { plural } from "../../format.ts";
import { PageBar } from "../../page-bar.tsx";
import { ErrorState, errorText, InlineError, SkeletonRows } from "../../ui.tsx";
import { CoordinationPage, type CoordinationSection } from "../coordination/page.tsx";
import { places, useProjects } from "../projects/queries.ts";
import { activeMesa, useMesas } from "../terminals/mesas.ts";
import { shortPath } from "../terminals/panel.tsx";
import {
  HARNESS_LABEL,
  type TerminalInfo,
  terminalLabel,
  useTerminalAction,
  useTerminals,
} from "../terminals/queries.ts";
import { Board } from "./board.tsx";
import { Lanes } from "./lanes.tsx";
import { type AgentsView, STATE_NOTE } from "./parts.tsx";
import { agentState, countAgents, sortAgents, useActivity, useAgents } from "./queries.ts";

// `h` a harness kind, `p` a projects tree node; both narrow the list. `v` picks the view: by
// state (the default) or as lanes on one clock.
export type AgentsSearch = {
  h?: string;
  p?: string;
  v?: "carriles";
  s?: CoordinationSection;
  a?: string;
};

const VIEWS = [
  { id: undefined, label: "Por estado" },
  { id: "carriles", label: "Carriles" },
] as const;

// Every agent and shell at a glance: what each is doing, where, what it costs and how busy it
// was lately. State and activity come with the terminals list; usage and Claude's own word are
// read every 5 s, the model calls every 30 s, both only while the page is visible.
export function AgentsPage({ search }: { search: AgentsSearch }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Secciones de Agentes"
        className="flex shrink-0 flex-wrap gap-1 border-b border-line px-3 py-2"
      >
        {(
          [
            { id: undefined, label: "Actividad" },
            { id: "consultas", label: "Consultas" },
            { id: "mensajes", label: "Mensajes" },
            { id: "reservas", label: "Reservas" },
          ] as const
        ).map((tab) => (
          <Link
            key={tab.label}
            to="/agentes"
            search={{ ...search, s: tab.id }}
            activeOptions={{ exact: true, includeSearch: true, explicitUndefined: true }}
            className="nav-item"
            aria-current={search.s === tab.id ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {search.s ? (
        <CoordinationPage section={search.s} agent={search.a} />
      ) : (
        <AgentsOverview search={search} />
      )}
    </div>
  );
}

function AgentsOverview({ search }: { search: AgentsSearch }) {
  const navigate = useNavigate();
  const terminals = useTerminals();
  const projects = useProjects();
  const agents = useAgents();
  const activity = useActivity();
  const action = useTerminalAction();

  const all = terminals.data?.terminals ?? [];
  const where = projects.data ? places(all, projects.data) : new Map();
  // Without the projects no terminal has a place, so a project filter would hide them all:
  // while they load the list waits, and if they fail the filter is set aside and said.
  const placing = projects.isPending && search.p !== undefined;
  const placeless = projects.isError && search.p !== undefined;
  const byId = new Map(agents.data?.app.map((a) => [a.id, a]));
  const status = (t: TerminalInfo) => byId.get(t.id)?.status;
  const shown = sortAgents(
    all.filter(
      (t) =>
        (!search.h || t.harness === search.h) &&
        (!search.p || placeless || where.get(t.id)?.node === search.p),
    ),
    status,
  );
  const counts = countAgents(shown, status);
  // Counts of terminals not read yet (loading, or a failed read) would say "0 trabajando".
  const countsText =
    !terminals.data || placing
      ? ""
      : [
          `${counts.working} trabajando`,
          `${counts.waiting} en espera`,
          plural(counts.ended, "terminada", "terminadas"),
          plural(counts.failed, "fallida", "fallidas"),
          ...(counts.unknown > 0 ? [`${counts.unknown} sin dato`] : []),
          ...(shown.length < all.length ? [`${shown.length} de ${all.length}`] : []),
        ].join(" · ");
  const projectOptions = [
    ...new Map([...where.values()].map((p) => [p.node, p.label])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  if (search.p && !projectOptions.some(([node]) => node === search.p))
    projectOptions.push([search.p, search.p]);
  const go = (next: AgentsSearch) =>
    void navigate({ to: "/agentes", search: { ...search, ...next } });

  const workspace = useMesas().workspace;
  const view: AgentsView = {
    rows: shown.map((t) => ({
      t,
      a: byId.get(t.id),
      state: agentState(t, status(t)),
      place: where.get(t.id),
      where: `${terminalLabel(t)} en ${shortPath(t.cwd)}`,
    })),
    outside: (agents.data?.outside ?? []).filter((s) => !search.h || s.harness === search.h),
    snapshot: { pending: agents.isPending, data: agents.data },
    calls: (key) => activity.data?.calls[key],
    now: Date.now(),
    grid: activeMesa(workspace).ids,
    act: (r, a) => action.mutate({ id: r.t.id, action: a }),
  };
  const View = search.v === "carriles" ? Lanes : Board;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar>
        <h1 className="font-semibold">Agentes</h1>
        {/* It gives way before the bar wraps: a second row would push the page down. */}
        <p
          className="min-w-0 flex-1 basis-0 truncate text-[12px] text-ink-2 tabular-nums"
          title={countsText}
        >
          {countsText}
        </p>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <fieldset aria-label="Vista" className="flex gap-0.5">
            {VIEWS.map((o) => (
              <button
                key={o.label}
                type="button"
                className="nav-item text-[12px]"
                aria-pressed={search.v === o.id}
                onClick={() => go({ v: o.id })}
              >
                {o.label}
              </button>
            ))}
          </fieldset>
          <select
            aria-label="Harness"
            className="btn"
            value={search.h ?? ""}
            onChange={(e) => go({ h: e.target.value || undefined })}
          >
            <option value="">Todos</option>
            {Object.entries(HARNESS_LABEL).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Proyecto"
            className="btn max-w-[220px]"
            value={search.p ?? ""}
            onChange={(e) => go({ p: e.target.value || undefined })}
          >
            <option value="">Todos los proyectos</option>
            {projectOptions.map(([node, label]) => (
              <option key={node} value={node}>
                {label}
              </option>
            ))}
          </select>
        </span>
      </PageBar>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {action.isError && (
          <InlineError className="text-[12px]">{errorText(action.error)}</InlineError>
        )}
        {agents.isError && (
          <InlineError className="text-[12px]">
            Sin consumo ni último estado: {errorText(agents.error)}
          </InlineError>
        )}
        {placeless && (
          <InlineError className="text-[12px]">
            Sin proyectos, el filtro por proyecto no se aplica: {errorText(projects.error)}
          </InlineError>
        )}
        {activity.isError && (
          <InlineError className="text-[12px]">
            Sin llamadas al modelo; cada tira muestra solo cuándo escribió:{" "}
            {errorText(activity.error)}
          </InlineError>
        )}
        {terminals.isPending || placing ? (
          <SkeletonRows count={4} />
        ) : terminals.isError ? (
          <ErrorState error={terminals.error} onRetry={() => terminals.refetch()} />
        ) : (
          <>
            {shown.length === 0 && (
              <p className="text-[12px] text-ink-2">
                {all.length === 0
                  ? "Ninguna terminal abierta en la app. Lánzala desde Proyectos o la Mesa."
                  : "Ninguna terminal coincide con el filtro."}
              </p>
            )}
            <View v={view} />
          </>
        )}
        <p className="max-w-[860px] text-[11px] text-ink-2">{STATE_NOTE}</p>
      </div>
    </div>
  );
}
