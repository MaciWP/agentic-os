import { InlineError } from "../../ui.tsx";
import { gitErrorText, type RepoUpdate, submoduleText } from "../git/queries.ts";

const UPDATE: Record<RepoUpdate["result"], (u: RepoUpdate) => string> = {
  updated: (u) => `avanzado ${u.commits} ${u.commits === 1 ? "commit" : "commits"}`,
  up_to_date: () => "al día",
  skipped: (u) => `sin tocar: ${u.detail}`,
  failed: (u) => `error: ${u.detail}`,
};

// "Actualizar repos": one line per main checkout, what happened and why.
export function UpdateLines({ items, error }: { items?: RepoUpdate[]; error: Error | null }) {
  if (error)
    return (
      <InlineError className="px-4 pb-2 text-[12px]">
        No se han podido actualizar los repos: {gitErrorText(error)}
      </InlineError>
    );
  if (!items) return null;
  return (
    <ul aria-label="Resultado de actualizar repos" className="space-y-0.5 px-4 pb-2 text-[12px]">
      {items.map((u) => (
        <li
          key={u.location}
          className={u.result === "failed" || u.submodules?.error ? "text-bad" : "text-ink-2"}
        >
          <span className="font-mono text-ink">{u.label}</span> {UPDATE[u.result](u)}
          {submoduleText(u.submodules) && ` · ${submoduleText(u.submodules)}`}
        </li>
      ))}
    </ul>
  );
}
