import { Tip } from "@/components/ui/tooltip";
import { Icon, type IconName } from "../../icons.tsx";
import { jobTile } from "../terminals/grid-state.ts";
import { EnvDot } from "./env-badge.tsx";
import { RemoveEnv } from "./env-remove.tsx";
import { envState } from "./queries.ts";
import { Node, RunningCount, running } from "./tree-node.tsx";
import type { Env, Tree } from "./tree-types.ts";

const Branch = ({ name }: { name: string | null }) =>
  name ? <span className="min-w-0 truncate font-mono text-[11px] text-ink-2">{name}</span> : null;

// The branch most checkouts of the env are on; none on a tie. Only a checkout off it shows its own.
export const usualBranch = (env: Pick<Env, "checkouts">) => {
  const count = new Map<string, number>();
  for (const c of env.checkouts) if (c.branch) count.set(c.branch, (count.get(c.branch) ?? 0) + 1);
  const [first, second] = [...count].sort((a, b) => b[1] - a[1]);
  return first && (!second || first[1] > second[1]) ? first[0] : null;
};

export function EnvNode({ env, tree }: { env: Env; tree: Tree }) {
  const id = `env:${env.name}`;
  const state = envState(env.repos, [
    ...(tree.byNode.get(id) ?? []),
    ...tree.envJobs.filter((j) => j.env === env.name),
  ]);
  const detail = env.repos
    .map(
      (r) =>
        `${r.repo}${r.docker ? ` · Docker ${r.docker}` : ""}${r.servers ? ` · servidores ${r.servers}` : ""}`,
    )
    .join("\n");
  const off = tree.pending || state === "busy" || Boolean(env.problem);
  // Start and stop say their word; the rest is an icon named by its label and its tooltip.
  const command = (
    action: "start" | "stop" | "update" | "logs",
    label: string,
    icon: IconName,
    tip: string,
    word = false,
  ) => {
    // The logs only read, so a busy env still shows them.
    const disabled = action === "logs" ? tree.pending : off;
    return (
      <Tip label={tip}>
        <button
          type="button"
          className={`btn-ghost ${word ? "gap-1 text-[11px]" : "px-1"}`}
          disabled={disabled}
          aria-label={`${label} ${env.name}`}
          // A disabled button shows no tooltip, so it says why in its title.
          title={disabled ? "Espera a que termine lo que está en curso" : undefined}
          onClick={() => tree.envCommand(action, env.name)}
        >
          <Icon name={icon} size={word ? 10 : 13} />
          {word && label}
        </button>
      </Tip>
    );
  };
  // A branch shows only on a checkout off the env's usual one; the usual one is in the title.
  const usual = usualBranch(env);
  const places = [id, ...env.checkouts.map((c) => c.location)];
  const output = () => tree.openTile(jobTile(env.name), id);
  return (
    <Node
      id={id}
      name={env.name}
      title={usual ? `Rama: ${usual}` : undefined}
      canLaunch={!env.problem}
      defaultOpen={false}
      holds={env.checkouts.some((c) => c.location === tree.selected.node)}
      tree={tree}
      icon={!env.problem && <EnvDot state={state} detail={detail} />}
      detail={
        env.problem ? (
          <span className="truncate text-[11px] text-warn">{env.problem}</span>
        ) : undefined
      }
      folded={<RunningCount n={running(places.flatMap((n) => tree.byNode.get(n) ?? []))} />}
      hoverActions={
        <>
          {state !== "up" &&
            command("start", "Levantar", "play", "Arranca sus contenedores y servidores", true)}
          {(state === "up" || state === "partial") &&
            command("stop", "Parar", "stop", "Para sus contenedores y servidores", true)}
          {command("update", "Actualizar", "refresh", "Actualizar: trae lo último de sus ramas")}
          {command("logs", "Logs", "logs", "Logs: abre sus registros en una terminal")}
          <Tip label="Ver salida: lo que escribió su última acción">
            <button
              type="button"
              className="btn-ghost px-1"
              aria-label="Ver salida"
              onClick={output}
            >
              <Icon name="output" size={13} />
            </button>
          </Tip>
          {/* A broken env (repos gone after a remove stopped half-way) is removed all the same. */}
          <RemoveEnv name={env.name} busy={tree.pending || state === "busy"} onStarted={output} />
        </>
      }
      nested={env.checkouts.map((c) => (
        <Node
          key={c.dir}
          id={c.location}
          name={c.dir}
          label={`${env.name}/${c.dir}`}
          canLaunch
          tree={tree}
          detail={c.branch !== usual && <Branch name={c.branch} />}
          actions={
            c.link && (
              <Tip label={`Abrir ${new URL(c.link).host}`}>
                <a
                  href={c.link}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost px-1"
                  aria-label={`Abrir la web de ${env.name}/${c.dir}`}
                >
                  <Icon name="link" size={13} />
                </a>
              </Tip>
            )
          }
        />
      ))}
    />
  );
}
