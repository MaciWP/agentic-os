import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../api.ts";
import { pollEvery } from "../../poll.ts";
import { GIT_POLL_MS } from "../git/queries.ts";

// The code tile's reads (server/features/code). Agents edit behind the app, so while the page
// is visible the open file is asked for again every few seconds, like the git tile (an
// unchanged file answers 304 from its ETag), and each open folder every fifteen.
const CODE = ["code"] as const;

export const codeTreeQuery = (location: string, dir: string) => ({
  queryKey: [...CODE, "tree", location, dir],
  queryFn: async () => unwrap(await api.api.code.tree.$get({ query: { location, dir } })),
});
export type CodeListing = Awaited<ReturnType<ReturnType<typeof codeTreeQuery>["queryFn"]>>;
export type CodeEntry = CodeListing["entries"][number];

export const codeFileQuery = (location: string, path: string) => ({
  queryKey: [...CODE, "file", location, path],
  queryFn: async () => unwrap(await api.api.code.file.$get({ query: { location, path } })),
});
export type CodeFile = Awaited<ReturnType<ReturnType<typeof codeFileQuery>["queryFn"]>>;

export const codeFilesQuery = (location: string) => ({
  queryKey: [...CODE, "files", location],
  queryFn: async () => unwrap(await api.api.code.files.$get({ query: { location } })),
});

export const codeDefinitionQuery = (location: string, path: string, name: string) => ({
  queryKey: [...CODE, "definition", location, path, name],
  queryFn: async () =>
    unwrap(await api.api.code.definition.$get({ query: { location, path, name } })),
});
export type Definition = Awaited<
  ReturnType<ReturnType<typeof codeDefinitionQuery>["queryFn"]>
>["hits"][number];

export const useCodeTree = (location: string, dir: string) =>
  useQuery({ ...codeTreeQuery(location, dir), refetchInterval: pollEvery(GIT_POLL_MS * 3) });
export const useCodeFile = (location: string, path: string) =>
  useQuery({
    ...codeFileQuery(location, path),
    enabled: Boolean(path),
    refetchInterval: pollEvery(GIT_POLL_MS),
  });
export const useCodeFiles = (location: string, on: boolean) =>
  useQuery({ ...codeFilesQuery(location), enabled: on, staleTime: 30_000 });

// Saves the editor's text over the version it opened (409 stale when the disk moved on).
export const saveCodeFile = async (location: string, path: string, text: string, base: string) =>
  unwrap(await api.api.code.file.$put({ json: { location, path, text, base } }));

// After a save the cached file is the saved one. A poll already on its way read the disk
// before the save and would bring the old text back as if an agent had written it: dropped.
export async function savedCodeFile(
  client: QueryClient,
  location: string,
  path: string,
  saved: { text: string; version: string; size: number; digest: string },
) {
  const { queryKey } = codeFileQuery(location, path);
  await client.cancelQueries({ queryKey });
  client.setQueryData<CodeFile>(queryKey, (old) =>
    old?.kind === "text" ? { ...old, ...saved } : old,
  );
}
