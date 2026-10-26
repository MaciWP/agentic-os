import { expect, test } from "bun:test";
import { machineUrl } from "./machine.ts";

test("the hub's own tab keeps every path", () => {
  expect(machineUrl("/api/terminals", "")).toBe("/api/terminals");
});

test("a worker tab sends machine paths through the hub's door and keeps hub-only ones", () => {
  expect(machineUrl("/api/terminals/a/attach", "win")).toBe("/api/machines/win/terminals/a/attach");
  expect(machineUrl("/api/code/raw?location=x", "win")).toBe(
    "/api/machines/win/code/raw?location=x",
  );
  expect(machineUrl("/api/events", "win")).toBe("/api/machines/win/events");
  for (const path of [
    "/api/tickets",
    "/api/tickets/K-1",
    "/api/usage?d=1",
    "/api/machines",
    "/api/memory/doc",
  ])
    expect(machineUrl(path, "win")).toBe(path);
  // A prefix only matches a whole segment.
  expect(machineUrl("/api/usagex", "win")).toBe("/api/machines/win/usagex");
  expect(machineUrl("/auth/atlassian/start", "win")).toBe("/auth/atlassian/start");
});
