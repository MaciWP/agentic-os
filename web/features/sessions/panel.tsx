import type { ExternalSession } from "../../../server/features/sessions/scan.ts";

const WORDS = {
  idle: "en espera",
  busy: "trabajando",
  waiting: "esperándote",
  shell: "en shell",
};

// Claude's own status word, shown only when the process is proven alive. Any other word
// has no label.
export const STATUS: typeof WORDS & Record<string, string | undefined> = WORDS;

export function sessionLabel(s: ExternalSession): { label: string; dot: string } {
  if (s.state === "activa")
    return { label: (s.status && STATUS[s.status]) ?? "activa", dot: "bg-ok" };
  if (s.state === "reciente") return { label: "actividad reciente", dot: "bg-warn" };
  return { label: "estado desconocido", dot: "bg-ink-2" };
}
