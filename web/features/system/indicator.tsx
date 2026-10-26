import { type ReactNode, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorText } from "../../ui.tsx";
import { AiSection } from "../ai/ai-section.tsx";
import { askDesktop, type DesktopPermission, desktopPermission } from "../alerts/desktop.ts";
import { HarnessChip, HarnessMark } from "../terminals/harness.tsx";
import { useOpenTile } from "../terminals/node-link.tsx";
import { type TerminalInfo, useTerminals } from "../terminals/queries.ts";
import {
  NO_TERMINALS,
  type RendererChoice,
  type RendererState,
  setRendererChoice,
  useRenderer,
} from "../terminals/renderer.ts";
import {
  DesktopRow,
  PlanRows,
  RendererRow,
  Row,
  ScreenRow,
  Section,
  usageOr,
} from "./panel-rows.tsx";
import { AGENTS } from "./plan-text.ts";
import { type ScreenChoice, type SystemSnapshot, useHoldScreen, useSystem } from "./queries.ts";
import { RestartDialog } from "./restart-dialog.tsx";
import { SystemLine } from "./system-line.tsx";

export function SystemPanel({
  s,
  list,
  now,
  onOpen,
  screen = { pending: false, error: null, onScreen: () => {} },
  desktop = { permission: "unsupported", onAsk: () => {} },
  onRestart = () => {},
  renderer = { state: NO_TERMINALS, onChoose: () => {} },
  children,
}: {
  s: SystemSnapshot;
  list: TerminalInfo[];
  now: number;
  onOpen: (id: string) => void;
  screen?: { pending: boolean; error: string | null; onScreen: (choice: ScreenChoice) => void };
  desktop?: { permission: DesktopPermission; onAsk: () => void };
  onRestart?: () => void;
  renderer?: { state: RendererState; onChoose: (choice: RendererChoice) => void };
  // Sections that read their own data (the local AI), after the snapshot's.
  children?: ReactNode;
}) {
  const byId = new Map(list.map((t) => [t.id, t]));
  return (
    <div className="flex flex-col gap-3">
      <Section title="App">
        <Row label="Servidor" value={usageOr(s.app.server)} />
        <Row label="PTY host" value={usageOr(s.app.host)} />
        {s.app.hostStale && (
          <p className="text-[12px] text-warn">
            El PTY host ejecuta código antiguo: los terminales nuevos salen con sus flags.
            «Reiniciar todo» carga el nuevo.
          </p>
        )}
        <button type="button" className="btn self-start" onClick={onRestart}>
          Reiniciar…
        </button>
      </Section>
      <Section title="Dibujo de terminales">
        <RendererRow {...renderer} />
      </Section>
      <Section title={`Terminales en marcha (${s.terminals.length})`}>
        {s.terminals.length === 0 && <p className="text-[12px] text-ink-2">Ninguno</p>}
        {s.terminals.map((u) => {
          const t = byId.get(u.id);
          return (
            <button
              key={u.id}
              type="button"
              onClick={() => onOpen(u.id)}
              className="-mx-1 rounded px-1 text-left hover:bg-hover"
              title="Abrir en la Mesa"
            >
              <Row label={t ? <HarnessChip t={t} /> : u.id} value={usageOr(u)} />
            </button>
          );
        })}
      </Section>
      {AGENTS.map(({ id, name }) => (
        <Section
          key={id}
          title={
            <span className="flex items-center gap-1.5">
              <HarnessMark kind={id} />
              Suscripción de {name}
            </span>
          }
        >
          <PlanRows agent={id} plan={s.plans[id]} now={now} />
        </Section>
      ))}
      <Section title="Mantener despierto">
        <p className="text-[12px] text-ink-2">
          {s.awake.remote
            ? "Acceso remoto: se mantiene despierto con el cargador. La pantalla puede apagarse o bloquearse."
            : s.awake.held
              ? "El Mac no se dormirá mientras haya terminales en marcha (con el cargador puesto)."
              : "Libre: no hay terminales en marcha."}
        </p>
        <ScreenRow screen={s.awake.screen} {...screen} />
      </Section>
      <Section title="Avisos del sistema">
        <DesktopRow {...desktop} />
      </Section>
      {children}
    </div>
  );
}

export function SystemIndicator() {
  const q = useSystem();
  const terminals = useTerminals();
  const openTile = useOpenTile();
  const hold = useHoldScreen();
  const renderer = useRenderer();
  // Read on each render: the alert cards can change it too. `bump` redraws after asking.
  const [, bump] = useState(0);
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  if (q.isError && !q.data) return <p className="text-[12px] text-bad">Sistema no disponible</p>;
  if (!q.data) return null;
  const now = Date.now();
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Consumo del sistema"
            // A failed poll keeps the last reading, dimmed, with the reason on hover.
            title={q.isError ? `Sin actualizar: ${errorText(q.error)}` : undefined}
            className={`rounded px-1 py-1 text-[12px] text-ink-2 hover:bg-hover ${q.isError ? "opacity-50" : ""}`}
          >
            <SystemLine s={q.data} now={now} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-h-(--radix-popover-content-available-height) w-80 overflow-y-auto"
        >
          <SystemPanel
            s={q.data}
            list={terminals.data?.terminals ?? []}
            now={now}
            onOpen={openTile}
            screen={{
              pending: hold.isPending,
              error: hold.isError ? errorText(hold.error) : null,
              onScreen: (choice) => hold.mutate(choice),
            }}
            desktop={{
              permission: desktopPermission(),
              onAsk: () => void askDesktop().then(() => bump((n) => n + 1)),
            }}
            onRestart={() => {
              setOpen(false);
              setRestarting(true);
            }}
            renderer={{ state: renderer, onChoose: setRendererChoice }}
          >
            <AiSection />
          </SystemPanel>
        </PopoverContent>
      </Popover>
      {restarting && (
        <RestartDialog
          list={terminals.data?.terminals}
          listError={terminals.isError ? errorText(terminals.error) : undefined}
          hostStale={q.data.app.hostStale}
          onClose={() => setRestarting(false)}
        />
      )}
    </>
  );
}
