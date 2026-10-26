import { describe, expect, test } from "bun:test";
import { ApiError } from "./api.ts";
import { failQuery, renderWith } from "./test-render.tsx";
import { ErrorState, InlineError } from "./ui.tsx";

const reconnect = new ApiError(401, "reconnect_required", "token expired");
const render = (remote: boolean) =>
  renderWith(<ErrorState error={reconnect} />, [[["access"], { remote, desktop: !remote }]]);

describe("ErrorState", () => {
  test("Jira's reconnect links to the OAuth start only on the Mac; remote says where to do it", async () => {
    const mac = await render(false);
    expect(mac).toContain('href="/auth/atlassian/start"');
    // The remote ingress refuses /auth/* with a 409 JSON page: no link there.
    const remote = await render(true);
    expect(remote).not.toContain("/auth/");
    expect(remote).toContain("Reconéctalo desde el Mac");
  });

  test("a failed access read keeps the reconnect link: the Mac is the usual case", async () => {
    const html = await renderWith(<ErrorState error={reconnect} />, [], failQuery(["access"]));
    expect(html).toContain('href="/auth/atlassian/start"');
  });
});

describe("ErrorState request ID", () => {
  test("a failed call shows the ID that finds its line in the server log", async () => {
    const err = new ApiError(503, "pty_host_unavailable", "host gone", null, null, "r-1");
    expect(await renderWith(<ErrorState error={err} />)).toContain("ID de la petición: r-1");
    expect(await renderWith(<ErrorState error={reconnect} />)).not.toContain("ID de la petición");
  });
});

describe("InlineError", () => {
  test("is read out at once, in the app's red, with the caller's spacing", async () => {
    const html = await renderWith(
      <InlineError className="px-4 text-[12px]">push failed</InlineError>,
    );
    expect(html).toBe('<p role="alert" class="text-bad px-4 text-[12px]">push failed</p>');
    const inline = await renderWith(<InlineError as="span">bad path</InlineError>);
    expect(inline).toBe('<span role="alert" class="text-bad">bad path</span>');
  });
});
