import { expect, test } from "bun:test";
import { z } from "zod";
import { netCause, ProviderError, parseProvider } from "./provider-error.ts";

test("provider validation stays typed without disclosing payload values", () => {
  expect(() => parseProvider("jira", z.number(), "private-upstream-payload")).toThrow(
    ProviderError,
  );
  try {
    parseProvider("jira", z.number(), "private-upstream-payload");
  } catch (error) {
    expect(error).toMatchObject({ provider: "jira", status: 502 });
    expect(String(error)).not.toContain("private-upstream-payload");
  }
  expect(parseProvider("jira", z.number(), 2)).toBe(2);
});

test("a fetch that never got an answer says why, not just TypeError", async () => {
  const cause = (url: string) => fetch(url).then(() => "answered", netCause);
  // Port 9 (discard) is closed on a developer machine; .invalid never resolves (RFC 6761).
  expect(await cause("http://127.0.0.1:9/")).toBe("ConnectionRefused");
  expect(await cause("http://no-such-host.invalid/")).toBe("ENOTFOUND");
  expect(netCause(new Error("x"))).toBe("Error");
  expect(netCause("text")).toBe("text");
});
