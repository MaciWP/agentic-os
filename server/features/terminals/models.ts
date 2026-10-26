import type { Database } from "bun:sqlite";
import type { TerminalInfo, Terminals } from "./contract.ts";
import { decorated } from "./decorated.ts";

// Each Claude terminal with its launch model, from its row: the host's wire carries none, and
// adding it would need a new host protocol, which a host with running terminals cannot take.
export function withModels(inner: Terminals, db: Database): Terminals {
  const row = db.query<{ model: string | null }, [string]>(
    "SELECT model FROM terminal_sessions WHERE id = ?",
  );
  const decorate = (t: TerminalInfo): TerminalInfo =>
    t.harness === "claude" ? { ...t, model: row.get(t.id)?.model ?? null } : t;
  return decorated(inner, decorate, () => () => {});
}
