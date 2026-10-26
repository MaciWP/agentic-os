// How long the hub waits for a worker to answer a write it relays. A held request through the
// hub (`aos wait --machine`) asks for less.
export const PROXY_WRITE_MS = 60_000;

// What only the hub has (Jira, GitHub, usage, notes, voice, the workboard, the machine list):
// served by the hub whatever machine a tab or the `aos` CLI works on.
const HUB_ONLY =
  /^\/api\/(tickets|github|usage|memory|voice|workboard|connections|kickoff|machines)(?=[/?]|$)/;

// An API path for a machine: the hub's own (machine ""), or the hub's door to that worker.
export function machinePath(path: string, machine: string): string {
  if (!machine || !path.startsWith("/api/") || HUB_ONLY.test(path)) return path;
  return `/api/machines/${encodeURIComponent(machine)}${path.slice("/api".length)}`;
}
