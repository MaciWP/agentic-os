import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticApp } from "./static.ts";

const root = mkdtempSync(join(tmpdir(), "aos-static-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), `<!doctype html><title>x</title>${"<p>a</p>".repeat(400)}`);
writeFileSync(join(root, "assets", "app-AbCd1234.js"), `console.log(1);\n`.repeat(400));
afterAll(() => rmSync(root, { recursive: true }));
const app = staticApp(root);
const get = (path: string, encoding?: string) =>
  app.request(path, { headers: encoding ? { "accept-encoding": encoding } : {} });

test("hashed assets are kept for good and compressed when the browser asks", async () => {
  const res = await get("/assets/app-AbCd1234.js", "gzip");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("content-encoding")).toBe("gzip");
  const plain = await get("/assets/app-AbCd1234.js");
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.text()).toStartWith("console.log(1);");
});

test("the page is checked on every load, also through the SPA fallback", async () => {
  for (const path of ["/", "/terminales"]) {
    const res = await get(path, "gzip");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  }
});

test("a missing chunk is a 404, not the page cached as a script", async () => {
  const res = await get("/assets/gone-ZZZZ9999.js");
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBeNull();
});

test("no other site can frame the page, so it cannot trick a click", async () => {
  for (const path of ["/", "/terminales", "/assets/app-AbCd1234.js"]) {
    const res = await get(path);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  }
});

test("the page runs only its own scripts and talks only to its own server", async () => {
  const csp = (await get("/")).headers.get("content-security-policy") ?? "";
  const directives = Object.fromEntries(
    csp.split(";").map((d) => {
      const [name = "", ...values] = d.trim().split(/\s+/);
      return [name, values.join(" ")];
    }),
  );
  // An injected <script>, inline handler or eval would reach a terminal through /send.
  expect(directives["script-src"]).toBe("'self' blob:");
  expect(directives["connect-src"]).toBe("'self'");
  expect(directives["object-src"]).toBe("'none'");
  expect(directives["base-uri"]).toBe("'none'");
  expect(directives["default-src"]).toBe("'self'");
});
