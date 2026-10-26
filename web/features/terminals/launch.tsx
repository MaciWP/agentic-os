import { useState } from "react";
import { ticketBranch } from "../../../shared/envs.ts";
import { type Effort, HARNESS_CAPABILITIES } from "../../../shared/harness-capabilities.ts";
import { ErrorState, InlineError, SkeletonRows } from "../../ui.tsx";
import { useMemoryDocs } from "../memory/queries.ts";
import {
  createEnv,
  createTerminal,
  HARNESS_LABEL,
  HARNESSES,
  type Harness,
  useEnvs,
  useLaunch,
  useTerminals,
} from "./queries.ts";

const NEW_ENV = "new";

// A model and effort to start with, picked by hand; none keeps each CLI's own default, as the
// ticket kickoff does (ADR 0012). Claude takes its CLI's aliases. Codex and Grok keep their
// configured model and change only the effort.
export type LaunchPreset = {
  id: string;
  harness: Exclude<Harness, "shell">;
  model?: string;
  effort: Effort;
  label: string;
};
const CLAUDE_PRESETS: [string, Effort][] = [
  ["opus", "high"],
  ["opus", "medium"],
  ["sonnet", "high"],
  ["sonnet", "medium"],
  ["haiku", "medium"],
];
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const LAUNCH_PRESETS: LaunchPreset[] = [
  ...CLAUDE_PRESETS.map(([model, effort]) => ({
    id: `claude:${model}:${effort}`,
    harness: "claude" as const,
    model,
    effort,
    label: `${capital(model)} · ${effort}`,
  })),
  ...(["codex", "grok"] as const).flatMap((harness) =>
    HARNESS_CAPABILITIES[harness].interactive.map((effort) => ({
      id: `${harness}::${effort}`,
      harness,
      effort,
      label: `Su modelo · ${effort}`,
    })),
  ),
];

type Envs = NonNullable<ReturnType<typeof useEnvs>["data"]>;

// The env made for this ticket, if there is one: same name as the key, or on its branch.
export function defaultLocation(envs: Envs["envs"], ticketKey: string): string {
  const env =
    envs.find((e) => !e.problem && e.name === ticketKey.toLowerCase()) ??
    envs.find((e) => !e.problem && e.branch === ticketKey);
  return env?.locations[0]?.id ?? NEW_ENV;
}

// What the form shows and submits. A refetch can drop the picked env; then it falls back to
// the default instead of showing one place and submitting another.
export function currentLocation(
  picked: string | null,
  envs: Envs,
  others: { id: string }[],
  ticketKey: string,
): string {
  const offered = [
    ...(envs.configured
      ? [NEW_ENV, ...envs.envs.flatMap((e) => e.locations.map((l) => l.id))]
      : []),
    ...others.map((l) => l.id),
  ];
  if (picked !== null && offered.includes(picked)) return picked;
  return envs.configured ? defaultLocation(envs.envs, ticketKey) : (others[0]?.id ?? "app");
}

export function LaunchAgent({ ticketKey }: { ticketKey: string }) {
  const envs = useEnvs();
  const terminals = useTerminals();
  return (
    <section aria-labelledby="launch-title" className="mt-5 rounded-lg border border-line p-4">
      <h2 id="launch-title" className="font-semibold">
        Lanzar agente
      </h2>
      {envs.isPending ? (
        <SkeletonRows count={2} />
      ) : envs.isError ? (
        <ErrorState error={envs.error} onRetry={() => envs.refetch()} />
      ) : (
        <LaunchForm
          key={ticketKey}
          ticketKey={ticketKey}
          envs={envs.data}
          others={terminals.data?.locations ?? []}
        />
      )}
    </section>
  );
}

function LaunchForm({
  ticketKey,
  envs,
  others,
}: {
  ticketKey: string;
  envs: Envs;
  others: { id: string; label: string }[];
}) {
  const [picked, setLocation] = useState<string | null>(null);
  const location = currentLocation(picked, envs, others, ticketKey);
  const [name, setName] = useState(ticketKey.toLowerCase());
  const [repos, setRepos] = useState<string[]>(envs.repos);
  const saved = useSavedPromptChoice();
  const [presetId, setPreset] = useState("");
  const preset = LAUNCH_PRESETS.find((p) => p.id === presetId);
  const run = useLaunch();
  const { pending, error } = run;
  const creating = envs.configured && location === NEW_ENV;

  const launch = (harness: Harness | null) =>
    run.launch(() =>
      harness
        ? createTerminal(harness, location, {
            ticket: ticketKey,
            savedPrompt: saved.value || undefined,
            ...(preset && { model: preset.model, effort: preset.effort }),
          })
        : createEnv(name, repos, ticketKey),
    );

  return (
    <div className="mt-3 space-y-3">
      {!envs.configured && (
        <p className="text-[12px] text-ink-2">
          No hay proveedor de entornos configurado; el agente solo puede arrancar en los directorios
          de la app.
        </p>
      )}
      <label className="block text-[12px] text-ink-2">
        Dónde
        <select
          className="btn mt-1 w-full"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        >
          {envs.configured && (
            <>
              <option value={NEW_ENV}>Crear entorno nuevo…</option>
              {envs.envs.map((e) => (
                <optgroup key={e.name} label={e.problem ? `${e.name}: ${e.problem}` : e.name}>
                  {e.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </>
          )}
          <optgroup label="Otros">
            {others.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      {creating ? (
        <>
          <label className="block text-[12px] text-ink-2">
            Nombre del entorno
            <input
              className="btn mt-1 w-full font-mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
          </label>
          <fieldset className="text-[12px]">
            <legend className="text-ink-2">Repos (rama {ticketBranch(ticketKey)})</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {envs.repos.map((r) => (
                <label key={r} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={repos.includes(r)}
                    onChange={(e) =>
                      setRepos((now) =>
                        e.target.checked ? [...now, r] : now.filter((x) => x !== r),
                      )
                    }
                  />
                  {r}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || repos.length === 0 || name.length === 0}
            onClick={() => launch(null)}
          >
            Crear entorno
          </button>
          <p className="text-[11px] text-ink-2">
            La creación corre en una terminal visible; si el proveedor pregunta algo, contestas
            allí. Al terminar, la misma ventana te deja lanzar el agente; solo arranca si el entorno
            aparece en la lista del proveedor.
          </p>
        </>
      ) : (
        <>
          <SavedPromptPicker choice={saved} />
          <label className="block text-[12px] text-ink-2">
            Modelo y esfuerzo
            <select
              className="btn mt-1 w-full"
              value={presetId}
              onChange={(e) => setPreset(e.target.value)}
            >
              <option value="">Los de cada CLI</option>
              {(["claude", "codex", "grok"] as const).map((h) => (
                <optgroup key={h} label={HARNESS_LABEL[h]}>
                  {LAUNCH_PRESETS.filter((p) => p.harness === h).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-4 gap-1">
            {HARNESSES.map((h) => (
              <button
                key={h}
                type="button"
                className="btn justify-center"
                disabled={pending || (preset !== undefined && preset.harness !== h)}
                onClick={() => launch(h)}
              >
                {HARNESS_LABEL[h]}
              </button>
            ))}
          </div>
          {preset && (
            <p className="text-[11px] text-ink-2">
              Con un modelo elegido solo se lanza {HARNESS_LABEL[preset.harness]}.
            </p>
          )}
          <p className="text-[11px] text-ink-2">
            Claude, Codex y Grok arrancan en modo sin confirmaciones de permisos: pueden modificar
            ficheros y ejecutar comandos directamente. El directorio no limita su acceso al equipo.
          </p>
        </>
      )}
      {error && <InlineError className="text-[12px]">{error}</InlineError>}
    </div>
  );
}

// A saved prompt adds the user's own instructions to what the agent starts on; a shell
// ignores it. Only ids from the prompts folder are offered, and the server checks again.
// The choice falls back to none when a refetch drops it, so the form never shows one thing
// and submits another.
export function useSavedPromptChoice() {
  const prompts = useMemoryDocs("prompts");
  const [picked, setPicked] = useState("");
  const docs = prompts.data?.docs ?? [];
  const value = docs.some((d) => d.id === picked) ? picked : "";
  return { value, set: setPicked, docs, pending: prompts.isPending, failed: prompts.isError };
}

export function SavedPromptPicker({ choice }: { choice: ReturnType<typeof useSavedPromptChoice> }) {
  return (
    <label className="block text-[12px] text-ink-2">
      Prompt guardado
      <select
        className="btn mt-1 w-full"
        value={choice.value}
        disabled={choice.pending}
        onChange={(e) => choice.set(e.target.value)}
      >
        <option value="">
          {choice.failed ? "No se pudieron leer los prompts" : "Ninguno (el prompt por defecto)"}
        </option>
        {choice.docs.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
          </option>
        ))}
      </select>
    </label>
  );
}
