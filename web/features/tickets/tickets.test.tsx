import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, unwrap } from "../../api.ts";
import { failQuery, renderWith } from "../../test-render.tsx";
import { ErrorState } from "../../ui.tsx";
import { AdfView, InlineMarkdown } from "./adf-view.tsx";
import { groupByStatus } from "./groups.ts";
import { TicketsPage } from "./page.tsx";
import { refreshTickets, ticketsQuery } from "./queries.ts";

const t = (key: string, name: string) => ({ key, status: { id: "1", name, category: "new" } });

describe("groupByStatus", () => {
  test("keeps the workflow order and puts unknown statuses last, by name", () => {
    const groups = groupByStatus([
      t("A", "Release Ready"),
      t("B", "Bloqueado"),
      t("C", "QUÉ"),
      t("D", "Release Ready"),
      t("E", "Archivado"),
    ]);
    expect(groups.map((g) => [g.status, g.known, g.tickets.map((x) => x.key)])).toEqual([
      ["QUÉ", true, ["C"]],
      ["Release Ready", true, ["A", "D"]],
      ["Archivado", false, ["E"]],
      ["Bloqueado", false, ["B"]],
    ]);
  });

  test("returns no groups for no tickets", () => {
    expect(groupByStatus([])).toEqual([]);
  });
});

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, marks });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const html = (value: unknown) => renderToStaticMarkup(<AdfView doc={value} />);

describe("AdfView", () => {
  test("renders marks, lists, task lists and tables", () => {
    const out = html(
      doc(
        {
          type: "paragraph",
          content: [text("bold", [{ type: "strong" }]), text("x", [{ type: "code" }])],
        },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("one")] }] }],
        },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("task")] }],
        },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [text("h")] }] },
            { type: "tableRow", content: [{ type: "tableCell", content: [text("c")] }] },
          ],
        },
      ),
    );
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('<code class="adf-code">x</code>');
    expect(out).toMatch(/<ul[^>]*><li[^>]*>.*one/);
    expect(out).toMatch(
      /type="checkbox"[^>]*checked=""[^>]*disabled=""|disabled=""[^>]*checked=""/,
    );
    expect(out).toMatch(/<th[^>]*>.*h.*<\/th>/);
    expect(out).toMatch(/<td[^>]*>.*c.*<\/td>/);
  });

  test("falls back to the text of unknown nodes", () => {
    expect(html(doc({ type: "futureNode", content: [text("kept")] }))).toContain("kept");
  });

  test("never links an unsafe href", () => {
    const out = html(
      doc({
        type: "paragraph",
        content: [text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])],
      }),
    );
    expect(out).toContain("click");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a");
  });

  test("says so when there is no description", () => {
    expect(html(null)).toContain("Sin descripción.");
  });
});

describe("InlineMarkdown", () => {
  const md = (value: string) => renderToStaticMarkup(<InlineMarkdown text={value} />);
  test("renders strong, code and safe links from adf.ts output", () => {
    expect(md("**Fuera:** guardar `x` en [S3](https://aws.example)")).toBe(
      '<strong>Fuera:</strong> guardar <code class="adf-code">x</code> en <a href="https://aws.example/" target="_blank" rel="noreferrer noopener" class="adf-link">S3</a>',
    );
  });
  test("keeps the label but drops an unsafe link", () => {
    expect(md("[go](javascript:alert(1))")).not.toContain("<a");
  });
});

describe("provider errors surface as errors", () => {
  const response = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status }) as unknown as Parameters<typeof unwrap>[0];

  test("unwrap throws ApiError with the server's code and detail", async () => {
    const err = await unwrap(
      response(401, { error: "reconnect_required", detail: "expired" }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "reconnect_required", detail: "expired" });
  });

  test("ErrorState offers reconnect only for reconnect_required", async () => {
    // The reconnect link exists only on the Mac (web/ui.test.tsx covers the remote side).
    const reconnect = await renderWith(
      <ErrorState error={new ApiError(401, "reconnect_required", "")} onRetry={() => {}} />,
      [[["access"], { remote: false, desktop: true }]],
    );
    expect(reconnect).toContain('href="/auth/atlassian/start"');
    expect(reconnect).toContain("Reintentar");

    const provider = renderToStaticMarkup(
      <ErrorState error={new ApiError(502, "provider_error", "Jira 503", "jira")} />,
    );
    expect(provider).toContain("Jira ha devuelto un error");
    expect(provider).toContain("Jira 503");
    expect(provider).not.toContain("/auth/atlassian/start");

    // An env provider failure is never blamed on Jira.
    const envs = renderToStaticMarkup(
      <ErrorState error={new ApiError(502, "provider_error", "list exited with 1", "envs")} />,
    );
    expect(envs).toContain("El proveedor de entornos ha fallado");
    expect(envs).not.toContain("Jira");
  });

  test("a failed read of the user's own tickets is said on the Tickets page", async () => {
    const html = await renderWith(
      <TicketsPage />,
      [],
      failQuery(["tickets"], undefined, "jira 502"),
    );
    expect(html).toContain("jira 502");
  });

  test("unwrap carries the failing provider", async () => {
    const err = await unwrap(
      response(502, { error: "provider_error", provider: "envs", detail: "boom" }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "provider_error", provider: "envs" });
  });
});

describe("refreshTickets", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const serve = (status: number, body: unknown) => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return urls;
  };
  const fresh = (urls: string[]) =>
    urls.map((u) => new URL(u, "http://x").searchParams.get("fresh"));
  // The tickets query as a mounted page holds it, after its first read.
  async function mounted(client: QueryClient) {
    const observer = new QueryObserver(client, ticketsQuery);
    const unsubscribe = observer.subscribe(() => {});
    while (observer.getCurrentResult().isFetching) await Bun.sleep(1);
    return unsubscribe;
  }

  test("asks the server for a fresh list and puts it in the tickets query", async () => {
    const client = new QueryClient();
    const urls = serve(200, { jql: "q", tickets: [{ key: "A-1" }] });
    const unmount = await mounted(client);
    await refreshTickets(client);
    unmount();
    expect(fresh(urls)).toEqual([null, "1"]);
    expect(client.getQueryData<unknown>(["tickets"])).toEqual({
      jql: "q",
      tickets: [{ key: "A-1" }],
    });
  });

  test("a push after a refresh reads the kept list again, not a fresh one", async () => {
    const client = new QueryClient();
    const urls = serve(200, { jql: "q", tickets: [] });
    const unmount = await mounted(client);
    await refreshTickets(client);
    await client.invalidateQueries({ queryKey: ["tickets"] });
    unmount();
    expect(fresh(urls)).toEqual([null, "1", null]);
  });

  test("a failure becomes the query's error, not a thrown one", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    serve(502, { error: "provider_error", provider: "jira", detail: "down" });
    const unmount = await mounted(client);
    await refreshTickets(client);
    unmount();
    expect(client.getQueryState(["tickets"])?.error).toMatchObject({ provider: "jira" });
  });
});
