import { useEffect, useState } from "react";
import { LOCAL_MODEL } from "../../../shared/harness-capabilities.ts";
import { Icon } from "../../icons.tsx";
import {
  Block,
  DisabledState,
  ErrorState,
  InlineError,
  SkeletonRows,
  StaleNotice,
} from "../../ui.tsx";
import { useAi } from "../ai/queries.ts";
import { useGitSummary, useUpdateRepos } from "../git/queries.ts";
import { codeTile, gitTile, jobTile } from "../terminals/grid-state.ts";
import { useOpenTile } from "../terminals/node-link.tsx";
import { createTerminal, runEnv, useLaunch, useTerminals } from "../terminals/queries.ts";
import { EnvsActions } from "./env.tsx";
import { useEnvJobs, useStartJob } from "./env-jobs.ts";
import { EnvNode } from "./env-node.tsx";
import { AddRepo } from "./places.tsx";
import { ProjectDot } from "./project-tag.tsx";
import { findNode, groupTerminals, useProjects } from "./queries.ts";
import { RepoNode } from "./repo-node.tsx";
import { isHarness, Node, pickedNode, type Tool, ToolBar } from "./tree-node.tsx";
import type { Repo, Tree } from "./tree-types.ts";
import { UpdateLines } from "./update-lines.tsx";

// What the Mesa points at: a node marked and unfolded in the tree, and maybe one of its
// terminals.
export type Selection = { node?: string; t?: string };

// Envs, repos with their worktrees, and the app's own folder, then the tickets and PRs that
// go into their terminals: the lower part of the Mesa's rail. A click marks a row and the bar
// on top opens its tools there, as tiles in the Mesa; `selected` is the node a link points at,
// which marks it too.
export function ProjectsTree({ selected = {} }: { selected?: Selection }) {
  const projects = useProjects();
  const terminals = useTerminals();
  const run = useLaunch();
  const openTile = useOpenTile();
  const jobs = useStartJob();
  const envJobs = useEnvJobs();
  const git = useGitSummary();
  const update = useUpdateRepos();
  const ai = useAi().data;
  const [marked, setMarked] = useState(() => selected.node || pickedNode.get());
  const mark = (id: string) => {
    setMarked(id);
    pickedNode.set(id);
  };
  // A link pointing at a node marks it.
  useEffect(() => {
    if (selected.node) setMarked(selected.node);
  }, [selected.node]);
  // Only a node the tree still has can be marked: an env removed leaves nothing marked. The
  // "app" location, once Agentic OS is a repo, is that repo's main.
  const markedId = marked === "app" && projects.data ? projects.data.app.location : marked;
  const found = markedId && projects.data ? findNode(projects.data, markedId) : null;
  const picked = found?.canLaunch ? { id: markedId, label: found.label } : null;
  const refused = (t: Tool) =>
    t === "git" && found?.kind === "env"
      ? "Sin git: el entorno no es un checkout"
      : t === "local" && ai?.state.gameMode
        ? "Modo juego activo en el PC"
        : null;
  const launch = (t: Tool) => {
    if (!picked) return;
    const location = picked.id;
    if (t === "git") return openTile(gitTile(location), location);
    if (t === "code") return openTile(codeTile(location), location);
    void run.launch(() =>
      isHarness(t)
        ? createTerminal(t, location)
        : createTerminal("claude", location, { model: LOCAL_MODEL }),
    );
  };
  const head = (
    <div className="sticky top-0 z-10 flex items-center gap-1 border-line border-b bg-panel px-2 py-1">
      <h2 className="px-1 font-semibold text-[12px]">Proyectos</h2>
      <span className="ml-auto min-w-0">
        <ToolBar
          picked={picked}
          busy={run.pending || jobs.pending}
          local={Boolean(ai)}
          refused={refused}
          onRun={launch}
        />
      </span>
    </div>
  );

  const all = terminals.data?.terminals ?? [];
  const alerts = (run.error ||
    jobs.error ||
    envJobs.isError ||
    terminals.isError ||
    git.isError) && (
    <div className="space-y-1 px-4 pt-3">
      {jobs.error && <InlineError className="text-[12px]">{jobs.error}</InlineError>}
      {run.error && <InlineError className="text-[12px]">{run.error}</InlineError>}
      {envJobs.isError && (
        <InlineError className="text-[12px]">
          No se pueden leer las acciones de los entornos: {envJobs.error.message}
        </InlineError>
      )}
      {terminals.isError &&
        (terminals.data ? (
          <StaleNotice error={terminals.error} onRetry={() => terminals.refetch()}>
            La lista de terminales puede estar desfasada
          </StaleNotice>
        ) : (
          <InlineError className="text-[12px]">
            No se pueden listar las terminales: {terminals.error.message}
          </InlineError>
        ))}
      {/* Without it every checkout would read as clean and in step with its upstream. */}
      {git.isError &&
        (git.data ? (
          <StaleNotice error={git.error} onRetry={() => git.refetch()}>
            Sin estado de git nuevo; los contadores pueden estar desfasados
          </StaleNotice>
        ) : (
          <InlineError className="text-[12px]">
            Sin estado de git, los contadores de cambios no se muestran: {git.error.message}{" "}
            <button type="button" className="underline" onClick={() => git.refetch()}>
              Reintentar
            </button>
          </InlineError>
        ))}
    </div>
  );

  // The env list is slow on a cold server. Its terminals stay in sight meanwhile: in their
  // Mesas, or under «Fuera de las Mesas».
  if (projects.isPending || projects.isError)
    return (
      <>
        {head}
        {alerts}
        {projects.isPending ? (
          <SkeletonRows count={6} />
        ) : (
          <ErrorState error={projects.error} onRetry={() => projects.refresh()} />
        )}
      </>
    );

  const p = projects.data;
  const { byNode } = groupTerminals(all, p);
  // A link to the "app" location, once Agentic OS is a repo, points at that repo's main.
  const at = selected.node === "app" ? p.app.location : selected.node;
  const tree: Tree = {
    byNode,
    git: git.data?.items ?? {},
    selected: { ...selected, node: at },
    pending: run.pending || jobs.pending,
    picked: picked?.id ?? null,
    pick: mark,
    openTile,
    envCommand: (action, name) =>
      action === "logs"
        ? run.launch(() => runEnv("logs", name))
        : void jobs
            .start({ action, name })
            .then((ok) => ok && openTile(jobTile(name), `env:${name}`)),
    envJobs: envJobs.data?.jobs ?? [],
    worktrees: p.worktrees,
  };
  // A section folded by hand opens for the node a link points at.
  const inEnvs = p.envs.items.some(
    (e) => `env:${e.name}` === at || e.checkouts.some((c) => c.location === at),
  );
  const holdsAt = (r: Repo) =>
    r.location === at || r.worktrees.some((w) => (w.location ?? w.path) === at);
  // Repos by the section their config names; the rest, with the app's own folder while it is
  // no repo, in «Otros proyectos». The terminals of no node sit under the app's own node.
  const groups = [...new Set(p.repos.flatMap((r) => (r.group ? [r.group] : [])))];
  const others = p.repos.filter((r) => !r.group);
  const appFolder = p.app.location === "app";
  // "Actualizar repos" acts on every repo; it sits on the first section that lists repos.
  const updateOn = groups[0] ?? null;
  const updateAction = p.repos.length > 0 && (
    <button
      type="button"
      className="btn-ghost"
      disabled={update.isPending}
      title="Busca cambios en cada repo y avanza los que están limpios y por detrás"
      onClick={() => update.mutate()}
    >
      {update.isPending ? "Actualizando repos…" : "Actualizar repos"}
    </button>
  );
  const updateLines = <UpdateLines items={update.data?.items} error={update.error} />;
  // The envs check out the repos of one section; there they nest, over its repos, as one pack.
  // Repos with no section, or spread over several, keep them a section of their own.
  const envGroups = new Set(p.envs.repos.map((id) => p.repos.find((r) => r.id === id)?.group));
  const envGroup = envGroups.size === 1 ? ([...envGroups][0] ?? null) : null;
  const envs = (
    <Block
      title="Entornos"
      plain
      collapsible
      nested={envGroup !== null}
      reveal={inEnvs}
      count={p.envs.configured ? p.envs.items.length : undefined}
      action={
        <span className="flex items-center gap-0.5">
          {/* Creating an env and the check-up work even when the list fails. */}
          {p.envs.configured && <EnvsActions envs={p.envs} />}
          {/* An icon here: with «Nuevo» and «Diagnóstico» the word does not fit a 300px rail. */}
          <button
            type="button"
            className="btn-ghost"
            aria-label={projects.isFetching ? "Actualizando…" : "Actualizar"}
            title={projects.isFetching ? "Actualizando…" : "Actualizar"}
            disabled={projects.isFetching}
            onClick={() => projects.refresh()}
          >
            <span className={`grid ${projects.isFetching ? "motion-safe:animate-spin" : ""}`}>
              <Icon name="refresh" size={14} />
            </span>
          </button>
        </span>
      }
    >
      {!p.envs.configured ? (
        <DisabledState provider="El proveedor de entornos" />
      ) : p.envs.error ? (
        <ErrorState
          error={new Error(p.envs.error)}
          provider="envs"
          onRetry={() => projects.refresh()}
        />
      ) : p.envs.items.length === 0 ? (
        <p className="px-4 pb-3 text-[12px] text-ink-2">
          Ningún entorno todavía; se crean con «Nuevo» o desde un ticket.
        </p>
      ) : (
        <ul className="px-2 pb-2">
          {p.envs.items.map((e) => (
            <EnvNode key={e.name} env={e} tree={tree} />
          ))}
        </ul>
      )}
    </Block>
  );
  return (
    <>
      {head}
      {alerts}
      {envGroup === null && envs}
      {groups.map((g) => {
        const repos = p.repos.filter((r) => r.group === g);
        const list = (
          <>
            {g === updateOn && updateLines}
            <ul className="px-2 pb-2">
              {repos.map((r) => (
                <RepoNode key={r.id} repo={r} tree={tree} />
              ))}
            </ul>
          </>
        );
        return g === envGroup ? (
          <Block
            key={g}
            title={g}
            plain
            mark={<ProjectDot name={g} />}
            collapsible
            reveal={inEnvs || repos.some(holdsAt)}
          >
            {envs}
            <Block
              title="Repositorios"
              plain
              collapsible
              nested
              reveal={repos.some(holdsAt)}
              count={repos.length}
              action={g === updateOn && updateAction}
            >
              {list}
            </Block>
          </Block>
        ) : (
          <Block
            key={g}
            title={g}
            plain
            mark={<ProjectDot name={g} />}
            collapsible
            reveal={repos.some(holdsAt)}
            count={repos.length}
            action={g === updateOn && updateAction}
          >
            {list}
          </Block>
        );
      })}
      <Block
        title="Otros proyectos"
        plain
        count={others.length + (appFolder ? 1 : 0)}
        collapsible
        reveal={at === p.app.location || others.some(holdsAt)}
        action={updateOn === null && updateAction}
      >
        {updateOn === null && updateLines}
        <ul className="px-2 pb-1">
          {others.map((r) => (
            <RepoNode key={r.id} repo={r} tree={tree} />
          ))}
          {appFolder && (
            <Node
              id={p.app.location}
              name={p.app.label}
              mono={false}
              icon={<Icon name="folder" size={12} />}
              canLaunch
              tree={tree}
            />
          )}
        </ul>
        <AddRepo />
      </Block>
    </>
  );
}
