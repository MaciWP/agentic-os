import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { Terminals } from "../terminals/contract.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { jiraAuthRoutes, loginOrigin } from "./routes.ts";

const jira = { site: "https://example.atlassian.net", project: "ABC" };
const config = (port: number, callbackUrl?: string) =>
  ConfigSchema.parse({ port, jira: { ...jira, ...(callbackUrl ? { callbackUrl } : {}) } });

describe("Jira login origin", () => {
  test("only the server on the registered callback's port can start a login", () => {
    expect(loginOrigin(config(4317))).toBeNull();
    expect(loginOrigin(config(4318))).toBe("http://localhost:4317");
    expect(loginOrigin(config(4318, "http://localhost:4318/auth/atlassian/callback"))).toBeNull();
    expect(loginOrigin(ConfigSchema.parse({ port: 4318 }))).toBeNull();
  });

  test("another port answers with its own page and never redirects to Atlassian", async () => {
    const deps = {
      config: config(4318),
      db: openDb(":memory:"),
      terminals: {} as Terminals,
      tokens: new AttachTokens(),
    };
    const res = await jiraAuthRoutes(deps, { invalidate: () => {} }).request("/start");
    expect(res.status).toBe(409);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("http://localhost:4317/auth/atlassian/callback");
    expect(html).toContain('href="http://localhost:4317/"');
  });
});
