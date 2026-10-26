import { MAX_RUNNING } from "../shared/terminals.ts";
import { MachineSwitch } from "./features/machines/switch.tsx";
import { useNarrow } from "./features/terminals/mobile.tsx";
import { phaseOf } from "./features/terminals/panel.tsx";
import { useTerminals } from "./features/terminals/queries.ts";
import { useConnections } from "./features/tickets/queries.ts";
import { shortcut } from "./keys.ts";
import { Reconnect } from "./ui.tsx";

const DOT: Record<string, string> = {
  connected: "bg-ok",
  not_connected: "bg-warn",
  missing_credentials: "bg-warn",
  error: "bg-bad",
};
const LABEL: Record<string, string> = { atlassian: "Jira", github: "GitHub", google: "Google" };
const STATUS: Record<string, string> = {
  connected: "conectado",
  not_connected: "sin conectar",
  missing_credentials: "faltan credenciales",
  error: "error",
};

// A dot and the provider's name each, the state in words only when it asks for something, and
// the detail on hover.
function Connections() {
  const q = useConnections();
  if (q.isError) return <p className="text-bad">Estado no disponible</p>;
  return (
    <ul aria-label="Conexiones" className="flex items-center gap-3">
      {q.data?.connections.map((c) => {
        const status = STATUS[c.status] ?? c.status;
        return (
          <li
            key={c.provider}
            className="flex items-center gap-1.5"
            title={[status, c.detail ?? c.account].filter(Boolean).join(" · ")}
          >
            <span className={`size-1.5 rounded-full ${DOT[c.status] ?? "bg-ink-2"}`} />
            <span className="text-ink">{LABEL[c.provider] ?? c.provider}</span>
            <span className={c.status === "connected" ? "sr-only" : "whitespace-nowrap"}>
              {status}
            </span>
            {(c.provider === "atlassian" || c.provider === "google") &&
              c.status !== "connected" && (
                <Reconnect provider={c.provider} className="text-primary">
                  Conectar
                </Reconnect>
              )}
          </li>
        );
      })}
    </ul>
  );
}

// How many terminals run against the server's cap, and how many agents work now. Nothing while
// the list has not loaded: a count of zero would be a guess.
function TerminalLoad() {
  const q = useTerminals();
  if (!q.data) return null;
  const running = q.data.terminals.filter((t) => t.state === "running");
  const working = running.filter((t) => phaseOf(t).key === "working").length;
  const full = running.length >= MAX_RUNNING;
  return (
    <>
      <span className="tabular-nums">
        {working} {working === 1 ? "trabaja" : "trabajan"}
      </span>
      <span
        className={`tabular-nums ${full ? "text-warn" : ""}`}
        title={full ? "Tope alcanzado: cierra una terminal para abrir otra" : undefined}
      >
        {running.length}/{MAX_RUNNING} terminales
      </span>
    </>
  );
}

// The strip along the foot of every page from md: the machine, the integrations, the load and
// the two shortcuts worth remembering. Not mounted below md, so a phone page reads nothing
// for a strip it never shows.
export function StatusBar() {
  if (useNarrow()) return null;
  return (
    <footer className="flex h-[26px] min-w-0 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-line bg-panel px-3 text-[11px] text-ink-2">
      <MachineSwitch />
      <Connections />
      <TerminalLoad />
      <span className="ml-auto hidden items-center gap-3 lg:flex">
        <span>
          <kbd className="font-sans text-ink">{shortcut("K")}</kbd> Buscar
        </span>
        <span>
          <kbd className="font-sans text-ink">{shortcut(".", { shift: true })}</kbd> Siguiente
        </span>
      </span>
    </footer>
  );
}
