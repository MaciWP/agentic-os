import { z } from "zod";
import { machinePath } from "../shared/machines.ts";
import { storageKey } from "./storage.ts";

// Which machine this tab works on: "" is the hub itself, else a worker id from config
// `machines`. Per tab (a terminal popout opened from it inherits it), read once at load:
// switching reloads the page, so no cached query or open socket crosses machines.
const stored = storageKey("aos.machine", { schema: z.string(), fallback: "", area: "session" });
export const currentMachine = stored.get();

// An API path for the tab's machine: the hub's own, or its door to the worker.
export const machineUrl = (path: string, machine = currentMachine) => machinePath(path, machine);

export function switchMachine(id: string) {
  if (id === currentMachine) return;
  stored.set(id);
  location.reload();
}
