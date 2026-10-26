import { type FormEvent, useState } from "react";
import { ENV_NAME, ISSUE_KEY } from "../../../shared/envs.ts";
import type { useStartJob } from "./env-jobs.ts";

// Why "Nuevo entorno" cannot start yet, in the words the form shows; null when it can. The
// server checks the same rules: without this the button stayed off, or answered a bare 400.
export function newEnvProblem(key: string, name: string, picked: string[], taken: string[]) {
  if (!key) return "Escribe la clave del ticket, p. ej. ABC-123.";
  if (!ISSUE_KEY.test(key))
    return `«${key}» no es una clave de ticket: letras, un guion y un número, p. ej. ABC-123.`;
  if (!name) return "Escribe un nombre para el entorno.";
  if (!ENV_NAME.test(name))
    return "El nombre solo admite minúsculas, números, punto, guion y guion bajo, y empieza por letra o número.";
  if (taken.includes(name)) return `Ya hay un entorno «${name}».`;
  if (picked.length === 0) return "Elige al menos un repo.";
  return null;
}

// "Nuevo entorno": a ticket key is the branch, its lowercase the default name, and the repos
// the profile offers.
export function NewEnvForm({
  repos,
  taken,
  jobs,
}: {
  repos: string[];
  taken: string[];
  jobs: ReturnType<typeof useStartJob>;
}) {
  const [ticket, setTicket] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(repos);
  const key = ticket.trim().toUpperCase();
  const envName = (name ?? key).trim().toLowerCase();
  const problem = newEnvProblem(key, envName, picked, taken);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem && !jobs.pending)
      void jobs.start({ action: "create", name: envName, repos: picked, branch: key });
  };
  return (
    <form onSubmit={submit} aria-label="Nuevo entorno" className="space-y-2 text-[12px]">
      <div className="flex flex-wrap gap-2">
        <label className="min-w-0 flex-1 basis-40 text-ink-2">
          Ticket (rama feature/&lt;clave&gt;)
          <input
            className="btn mt-1 w-full font-mono"
            value={ticket}
            maxLength={40}
            spellCheck={false}
            autoCapitalize="characters"
            onChange={(e) => setTicket(e.target.value)}
          />
        </label>
        <label className="min-w-0 flex-1 basis-40 text-ink-2">
          Nombre
          <input
            className="btn mt-1 w-full font-mono"
            value={envName}
            maxLength={63}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>
      <fieldset>
        <legend className="text-ink-2">Repos</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {repos.map((r) => (
            <label key={r} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={picked.includes(r)}
                onChange={(e) =>
                  setPicked((now) => (e.target.checked ? [...now, r] : now.filter((x) => x !== r)))
                }
              />
              <span className="font-mono">{r}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={Boolean(problem) || jobs.pending}
        aria-describedby="new-env-why"
      >
        Crear entorno
      </button>
      <p id="new-env-why" className="text-ink-2">
        {problem ?? "Tarda unos minutos; el progreso sale aquí debajo."}
      </p>
    </form>
  );
}
