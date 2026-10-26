import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { machineUrl } from "./machine.ts";

const Access = z.object({ remote: z.boolean(), desktop: z.boolean() });
// Whether this device came through the remote ingress; the Mac is the desktop.
export async function readAccess() {
  const response = await fetch(machineUrl("/api/access"));
  if (!response.ok) throw new Error("No se pueden comprobar las funciones de este dispositivo.");
  return Access.parse(await response.json());
}

export function useAccess() {
  return useQuery({ queryKey: ["access"], queryFn: readAccess, staleTime: Infinity });
}
