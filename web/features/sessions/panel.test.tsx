import { describe, expect, test } from "bun:test";
import type { ExternalSession } from "../../../server/features/sessions/scan.ts";
import { sessionLabel } from "./panel.tsx";

const session = (over: Partial<ExternalSession>): ExternalSession => ({
  harness: "claude",
  id: "s",
  pid: 1,
  cwd: "/w/env-a/backend",
  name: null,
  kind: null,
  status: null,
  state: "activa",
  startedAt: null,
  updatedAt: null,
  ...over,
});

describe("sessionLabel", () => {
  test("only a proven process reads as alive; the rest say how sure they are", () => {
    expect(sessionLabel(session({ status: "waiting" })).label).toBe("esperándote");
    expect(sessionLabel(session({ status: "something-new" })).label).toBe("activa");
    expect(sessionLabel(session({ state: "reciente", status: "busy" })).label).toBe(
      "actividad reciente",
    );
    expect(sessionLabel(session({ state: "desconocida" })).label).toBe("estado desconocido");
  });
});
