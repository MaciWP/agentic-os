import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SourceId } from "../../../server/features/memory/sources.ts";
import type { Doc, DocSummary } from "../../../server/features/memory/store.ts";
import { ApiError, api, mutate, unwrap } from "../../api.ts";
import { appendLine } from "./journal.ts";

export type { Doc, DocSummary, SourceId };

export const HARNESS_SOURCES: SourceId[] = ["claude-memory", "claude-md", "codex", "grok"];

export function useMemorySources() {
  return useQuery({
    queryKey: ["memory", "sources"],
    queryFn: async () => unwrap(await api.api.memory.sources.$get()),
  });
}

const docsQuery = (source: SourceId) => ({
  queryKey: ["memory", "docs", source],
  queryFn: async () => unwrap(await api.api.memory.docs.$get({ query: { source } })),
});

export function useMemoryDocs(source: SourceId) {
  return useQuery(docsQuery(source));
}

// Several sources as one newest-first list.
export function useSourcesDocs(sources: SourceId[]) {
  return useQueries({
    queries: sources.map(docsQuery),
    combine: (results) => ({
      isPending: results.some((q) => q.isPending),
      error: results.find((q) => q.isError)?.error ?? null,
      // A failed refetch keeps the docs it had; only a list never read leaves nothing to show.
      hasData: results.every((q) => q.data !== undefined),
      refetch: () => {
        for (const q of results) q.refetch();
      },
      docs: results.flatMap((q) => q.data?.docs ?? []).sort((a, b) => b.mtime - a.mtime),
    }),
  });
}

// The work bar's buttons: the saved prompts marked `bar: true`.
export function useWorkBar() {
  return useQuery({
    queryKey: ["memory", "bar"],
    queryFn: async () => unwrap(await api.api.memory.bar.$get()),
  });
}

export function useMemorySearch(q: string) {
  const text = q.trim();
  return useQuery({
    queryKey: ["memory", "search", text],
    queryFn: async () => unwrap(await api.api.memory.search.$get({ query: { q: text } })),
    enabled: text.length > 0,
    placeholderData: (previous) => previous,
  });
}

// One doc's read, for a hook or a one-off fetch.
export const docQuery = (id: string) => ({
  queryKey: ["memory", "doc", id],
  queryFn: async () => unwrap(await api.api.memory.doc.$get({ query: { id } })),
});

export function useMemoryDoc(id: string) {
  return useQuery({
    ...docQuery(id),
    enabled: id.length > 0,
    // An open editor must not be replaced under the user's typing.
    refetchOnWindowFocus: false,
  });
}

export const createDoc = (source: SourceId, name: string, body: string) =>
  mutate<{ doc: Doc }>("/api/memory/doc", "POST", { source, name, body });
export const saveDoc = (id: string, body: string, mtime: number) =>
  mutate<{ doc: Doc }>("/api/memory/doc", "PUT", { id, body, mtime });
export const deleteDoc = async (id: string, mtime: number, body: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const version = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return mutate<{ ok: true; recovery: string }>("/api/memory/doc", "DELETE", {
    id,
    mtime,
    version,
  });
};

// A line at the end of a note of the user's, created with `title` when it does not exist. A
// note changed under the write (409 stale) is read again once; never written blind.
export async function appendToNote(name: string, title: string, line: string): Promise<Doc> {
  try {
    return (await createDoc("notes", name, `# ${title}\n\n${line}\n`)).doc;
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "exists")) throw err;
  }
  const id = `notes:${name}.md`;
  for (let attempt = 0; ; attempt++) {
    const { doc } = await unwrap(await api.api.memory.doc.$get({ query: { id } }));
    try {
      return (await saveDoc(id, appendLine(doc.body, line), doc.mtime)).doc;
    } catch (err) {
      if (attempt > 0 || !(err instanceof ApiError && err.code === "stale")) throw err;
    }
  }
}

export function useInvalidateMemory() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["memory"] });
}

// Snippet marks from the server (\u0002 … \u0003) into plain and highlighted runs.
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
  const [head = "", ...rest] = snippet.split(START);
  const parts = [{ text: head, mark: false }];
  for (const segment of rest) {
    const end = segment.indexOf(END);
    if (end < 0) parts.push({ text: segment, mark: false });
    else
      parts.push(
        { text: segment.slice(0, end), mark: true },
        { text: segment.slice(end + 1), mark: false },
      );
  }
  return parts
    .map((p) => ({ ...p, text: p.text.split(END).join("") }))
    .filter((p) => p.text.length > 0);
}

const START = String.fromCharCode(2);
const END = String.fromCharCode(3);
