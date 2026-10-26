import { useQuery } from "@tanstack/react-query";
import type { FolderEntry, Listing, Place } from "../../../server/features/files/browse.ts";
import { api, unwrap } from "../../api.ts";

export type { FolderEntry, Listing, Place };

// One folder of the host, read each time it is shown. No retry: a missing folder or a
// privacy refusal is an answer, shown as it comes.
export const useFolders = (path: string | null) =>
  useQuery({
    queryKey: ["files", "folders", path],
    queryFn: async () => unwrap(await api.api.files.folders.$get({ query: { path: path ?? "" } })),
    enabled: path !== null,
    retry: false,
  });

// Where a picker can jump, and the host's home.
export const usePlaces = () =>
  useQuery({
    queryKey: ["files", "places"],
    queryFn: async () => unwrap(await api.api.files.places.$get()),
  });
