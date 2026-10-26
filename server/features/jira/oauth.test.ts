import { describe, expect, test } from "bun:test";
import { consumeState, createState, pickJiraResource } from "./oauth.ts";

describe("OAuth state", () => {
  test("is accepted once when the cookie matches", () => {
    const s = createState("http://localhost:4317/");
    expect(consumeState(s, s)).toEqual({ ok: true, returnTo: "http://localhost:4317/" });
  });
  test("cannot be replayed", () => {
    const s = createState("/");
    consumeState(s, s);
    expect(consumeState(s, s)).toEqual({ ok: false, reason: "state_unknown_or_used" });
  });
  test("must match the cookie", () => {
    const s = createState("/");
    expect(consumeState(s, "other")).toEqual({ ok: false, reason: "state_mismatch" });
    expect(consumeState(s, undefined)).toEqual({ ok: false, reason: "state_mismatch" });
  });
  test("expires after 10 minutes", () => {
    const t0 = Date.now();
    const s = createState("/", t0);
    expect(consumeState(s, s, t0 + 10 * 60_000 + 1)).toEqual({
      ok: false,
      reason: "state_expired",
    });
  });
});

describe("pickJiraResource", () => {
  const site = "https://acme.atlassian.net";
  const confluence = { id: "c1", url: site, name: "acme", scopes: ["read:page:confluence"] };
  const jira = { id: "c1", url: site, name: "acme", scopes: ["read:jira-work", "write:jira-work"] };
  const other = {
    id: "c2",
    url: "https://other.atlassian.net",
    name: "o",
    scopes: ["read:jira-work"],
  };
  test("picks the Jira entry for the configured site, not the first entry", () => {
    expect(pickJiraResource([other, confluence, jira], `${site}/`)).toBe(jira);
  });
  test("returns null when the configured site has no Jira access", () => {
    expect(pickJiraResource([other, confluence], site)).toBeNull();
  });
});
