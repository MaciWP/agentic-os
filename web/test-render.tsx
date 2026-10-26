import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// A query whose last read failed; with `data`, a refetch that failed after a good read.
export const failQuery =
  (key: unknown[], data?: unknown, message = "read failed") =>
  (client: QueryClient) =>
    client
      .getQueryCache()
      .build(client, { queryKey: key })
      .setState({ status: "error", error: new Error(message), fetchStatus: "idle", data });

// Links need a router; panels need their queries already answered. A failed query with no
// data would retry on mount, which reads as loading again, so mounts never retry.
export async function renderWith(
  node: ReactNode,
  data: [unknown[], unknown][] = [],
  setup?: (client: QueryClient) => void,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  for (const [key, value] of data) client.setQueryData(key, value);
  setup?.(client);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory(),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
