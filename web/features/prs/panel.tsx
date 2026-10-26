import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Pr, PrKind } from "../../../server/features/github/prs.ts";
import { api, serverCachedQuery, unwrap } from "../../api.ts";
import { InlineError } from "../../ui.tsx";
import { SavedPromptPicker, useSavedPromptChoice } from "../terminals/launch.tsx";
import { createTerminal, HARNESS_LABEL, type Harness, useLaunch } from "../terminals/queries.ts";

export const PR_GROUPS: { kind: PrKind; label: string }[] = [
  { kind: "review", label: "Te piden revisión" },
  { kind: "mine", label: "Tuyas" },
  { kind: "open", label: "Otras abiertas" },
];
const REVIEWERS: Exclude<Harness, "shell">[] = ["claude", "codex", "grok"];

// One server watcher is shared by all connected browsers.
const prsQuery = serverCachedQuery("prs", async (query) =>
  unwrap(await api.api.github.prs.$get({ query })),
);
export function usePullRequests() {
  const client = useQueryClient();
  const q = useQuery(prsQuery.query);
  return { ...q, refetch: () => prsQuery.refresh(client) };
}

// "Revisar" with the launcher in a popover, for a PR shown outside this block (Inicio's lanes).
// The launch state lives here, not in the popover, so closing it mid-launch cannot start a
// second terminal on reopen.
export function ReviewButton({
  pr,
  className = "btn-ghost text-ink",
}: {
  pr: Pr;
  className?: string;
}) {
  const saved = useSavedPromptChoice();
  const run = useLaunch();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={className} aria-label={`Revisar ${pr.repo}#${pr.number}`}>
          Revisar
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <ReviewLauncher pr={pr} saved={saved} run={run} />
      </PopoverContent>
    </Popover>
  );
}

function ReviewLauncher({
  pr,
  saved,
  run,
  className,
}: {
  pr: Pr;
  saved: ReturnType<typeof useSavedPromptChoice>;
  run: ReturnType<typeof useLaunch>;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <SavedPromptPicker choice={saved} />
      <div className="grid grid-cols-3 gap-1">
        {REVIEWERS.map((h) => (
          <button
            key={h}
            type="button"
            className="btn justify-center"
            disabled={run.pending}
            onClick={() =>
              run.launch(() =>
                createTerminal(h, `repo:${pr.repo}`, {
                  review: { repo: pr.repo, number: pr.number },
                  savedPrompt: saved.value || undefined,
                }),
              )
            }
          >
            {HARNESS_LABEL[h]}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-ink-2">
        Arranca en el checkout del repo con los permisos habituales del agente, incluido el bypass.
        El prompt pide revisar la PR sin modificar ni publicar, pero no impone un aislamiento de
        solo lectura. Para una revisión restringida, usa Consultas en Agentes.
      </p>
      {run.error && <InlineError className="text-[12px]">{run.error}</InlineError>}
    </div>
  );
}
