import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Consultation, MessageRecord } from "../../../shared/coordination.ts";
import { api, mutate, unwrap } from "../../api.ts";

const load = async () => unwrap(await api.api.coordination.$get());
export type Summary = Awaited<ReturnType<typeof load>>;
export function useCoordination() {
  return useQuery({
    queryKey: ["coordination"],
    queryFn: load,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
export function useCapabilities() {
  return useQuery({
    queryKey: ["coordination", "capabilities"],
    queryFn: async () => unwrap(await api.api.coordination.capabilities.$get()),
    staleTime: 60_000,
  });
}
export function useConsultation(id: string) {
  return useQuery({
    queryKey: ["coordination", "consultation", id],
    enabled: Boolean(id),
    queryFn: async () =>
      Consultation.parse(
        await unwrap(await api.api.coordination.consultations[":id"].$get({ param: { id } })),
      ),
  });
}
export function useMessage(id: string) {
  return useQuery({
    queryKey: ["coordination", "message", id],
    enabled: Boolean(id),
    queryFn: async () =>
      MessageRecord.parse(
        await unwrap(await api.api.coordination.messages[":id"].$get({ param: { id } })),
      ),
  });
}
export function useCoordAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      path,
      method = "POST",
      body = {},
    }: {
      path: string;
      method?: "POST" | "DELETE";
      body?: unknown;
    }) => mutate<unknown>(`/api/coordination${path}`, method, body),
    onSettled: () => client.invalidateQueries({ queryKey: ["coordination"] }),
  });
}
export const STATE: Record<string, string> = {
  preparing: "Preparando captura",
  pending: "Pendiente de aprobación",
  approved: "Aprobada",
  running: "En curso",
  finished: "Finalizada",
  failed: "Fallida",
  cancelled: "Cancelada",
  queued: "Pendiente",
  succeeded: "Completada",
  timed_out: "Tiempo agotado",
  interrupted: "Interrumpida",
  delivering: "Enviando",
  delivered: "Entregado",
  answered: "Con respuesta",
  uncertain: "Entrega incierta",
  active: "Activa",
  orphaned: "Huérfana",
  lost: "Perdido",
  exited: "Terminado",
};
export const field = "w-full min-w-0 rounded-md border border-line bg-panel px-3 py-2 text-[13px]";
