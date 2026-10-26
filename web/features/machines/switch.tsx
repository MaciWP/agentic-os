import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, unwrap } from "../../api.ts";
import { currentMachine, switchMachine } from "../../machine.ts";
import { pollEvery } from "../../poll.ts";
import { InlineError } from "../../ui.tsx";
import { UpdateDialog } from "./update-dialog.tsx";

// Which machine this tab works on, beside the app's name. Hidden while the hub drives no other
// machine. A worker that does not answer stays listed, marked, so the tab can still go back; the
// one this tab works on says why on screen, since a phone never shows a `title`.
export function MachineSwitch() {
  const q = useQuery({
    queryKey: ["machines"],
    queryFn: async () => unwrap(await api.api.machines.$get()),
    refetchInterval: pollEvery(15_000),
  });
  const [updating, setUpdating] = useState<{ id: string; label: string } | null>(null);
  const machines = q.data?.machines ?? [];
  // A worker that answers with code other than this hub's: never updated, or behind.
  const behind = machines.filter((m) => m.online && m.version !== q.data?.version);
  if (machines.length === 0 && !currentMachine) return null;
  const here = machines.find((m) => m.id === currentMachine && !m.online);
  const options = [
    { id: "", label: "Mac", online: true, title: "Este Mac" },
    ...machines.map((m) => ({
      id: m.id,
      label: m.label,
      online: m.online,
      title: m.online ? `${m.label} · ${m.ms} ms` : `${m.label} no responde: ${m.error ?? ""}`,
    })),
  ];
  return (
    <fieldset className="flex shrink-0 items-center gap-0.5 rounded-md border border-line p-0.5">
      <legend className="sr-only">Máquina</legend>
      {options.map((o) => (
        <button
          key={o.id || "hub"}
          type="button"
          title={o.title}
          aria-pressed={o.id === currentMachine}
          onClick={() => switchMachine(o.id)}
          className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] text-ink-2 aria-pressed:bg-[var(--selected)] aria-pressed:text-ink"
        >
          <span aria-hidden className={`size-1.5 rounded-full ${o.online ? "bg-ok" : "bg-bad"}`} />
          {o.label}
        </button>
      ))}
      {here?.error && (
        <span
          title={here.error}
          className="min-w-0 max-w-[40vw] truncate px-1 text-[12px] md:max-w-[18rem]"
        >
          <InlineError as="span">{here.error}</InlineError>
        </span>
      )}
      {behind.map((m) => (
        <button
          key={`update-${m.id}`}
          type="button"
          title={`${m.label} no tiene el código de este Mac`}
          onClick={() => setUpdating(m)}
          className="rounded px-2 py-0.5 text-[12px] text-warn"
        >
          Actualizar {m.label}
        </button>
      ))}
      {updating && <UpdateDialog machine={updating} onClose={() => setUpdating(null)} />}
    </fieldset>
  );
}
