import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GoalTitle, type Objective, objectiveLabel } from "../../../shared/objectives.ts";
import { Icon } from "../../icons.tsx";
import { errorText } from "../../ui.tsx";
import { TERM_ICON } from "../terminals/panel.tsx";
import { type TerminalInfo, useTerminals } from "../terminals/queries.ts";
import { useObjectiveActions, useObjectives } from "./queries.ts";

const TICKETS_SHOWN = 8;
const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]";

// What a terminal works on, in its tile header: its name, giving way like the terminal's, or
// only an icon while there is none, so the header keeps its room for the terminal's name. The list sets it: an open goal, a ticket
// already in use, a new goal, none, or back to the ticket it was launched with.
export function ObjectiveChip({ t }: { t: TerminalInfo }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const objectives = useObjectives();
  const all = useTerminals().data?.terminals ?? [];
  const act = useObjectiveActions();
  const current = t.objective ?? null;
  const label = current ? objectiveLabel(current) : "Sin objetivo";
  const goals = (objectives.data?.objectives ?? []).filter(
    (o): o is Extract<Objective, { kind: "goal" }> => o.kind === "goal",
  );
  const tickets = [
    ...new Set([
      ...all.flatMap((x) => (x.ticket ? [x.ticket] : [])),
      ...(objectives.data?.objectives ?? []).flatMap((o) =>
        o.kind === "ticket" ? [o.ticket] : [],
      ),
    ]),
  ].slice(0, TICKETS_SHOWN);
  const run = async (p: () => Promise<unknown>) => {
    try {
      await p();
      setError(null);
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const isCurrent = (o: Objective) =>
    current?.kind === o.kind &&
    (o.kind === "goal"
      ? current.id === o.id
      : current.kind === "ticket" && current.ticket === o.ticket);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={
            current ? "pill h-6 min-w-0 max-w-[10rem] text-ink hover:bg-[var(--hover)]" : TERM_ICON
          }
          aria-label={`Objetivo: ${label}`}
          title={`Objetivo: ${label}. Cambiarlo`}
        >
          {current ? <span className="truncate">{label}</span> : <Icon name="goal" size={14} />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1 text-[12px]">
        <form
          className="p-1"
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = GoalTitle.safeParse(title);
            if (!parsed.success) return setError("Escribe el objetivo: hasta 200 caracteres.");
            void run(async () => {
              const { objective } = await act.create(parsed.data);
              await act.choose(t.id, { objective: objective.id as number });
              setTitle("");
            });
          }}
        >
          <input
            aria-label="Nuevo objetivo"
            placeholder="Nuevo objetivo…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border border-line bg-panel px-2 py-1"
          />
        </form>
        {error && (
          <p role="alert" className="px-2 py-1 text-bad">
            {error}
          </p>
        )}
        {objectives.isError && (
          <p role="alert" className="px-2 py-1 text-bad">
            No se pudieron leer los objetivos: {errorText(objectives.error)}
          </p>
        )}
        <ul aria-label="Objetivos" className="max-h-72 overflow-y-auto">
          {goals.map((g) => (
            <li key={g.id} className="flex items-center">
              <button
                type="button"
                className={ROW}
                aria-current={isCurrent(g) ? "true" : undefined}
                onClick={() => run(() => act.choose(t.id, { objective: g.id }))}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full border-2 border-primary/60"
                />
                <span className="truncate">{g.title}</span>
              </button>
              <button
                type="button"
                className="shrink-0 rounded px-2 py-1.5 text-ink-2 hover:bg-[var(--hover)] hover:text-ink"
                aria-label={`Cerrar el objetivo ${g.title}`}
                title="Cerrar el objetivo: deja la lista, su consumo se queda"
                onClick={() => run(() => act.close(g.id))}
              >
                Cerrar
              </button>
            </li>
          ))}
          {tickets.map((k) => (
            <li key={k}>
              <button
                type="button"
                className={`${ROW} font-mono`}
                aria-current={
                  current?.kind === "ticket" && current.ticket === k ? "true" : undefined
                }
                onClick={() => run(() => act.choose(t.id, { ticket: k }))}
              >
                {k}
              </button>
            </li>
          ))}
          <li className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              className={ROW}
              aria-current={current === null ? "true" : undefined}
              onClick={() => run(() => act.choose(t.id, { none: true }))}
            >
              Sin objetivo
            </button>
          </li>
          <li>
            <button
              type="button"
              className={ROW}
              onClick={() => run(() => act.choose(t.id, { launch: true }))}
            >
              El del lanzamiento
            </button>
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
