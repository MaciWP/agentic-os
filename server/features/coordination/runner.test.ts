import { expect, test } from "bun:test";
import { ConsultationInput } from "../../../shared/coordination.ts";
import { openDb } from "../../db.ts";
import { CONSULT_BUDGET_USD, consultationArgs, parseResult } from "./adapters.ts";
import { ConsultationRunner, newAttempt } from "./runner.ts";
import { CoordinationStore } from "./store.ts";

const setup = () => {
  const store = new CoordinationStore(openDb(":memory:"));
  const q = store.createConsultation(
    "user",
    ConsultationInput.parse({
      requestId: "q",
      location: "repo:test",
      prompt: "Review",
      participants: [
        { harness: "claude", model: "test" },
        { harness: "codex", model: "test" },
      ],
    }),
    "/repo",
    "context",
  );
  store.updateConsultation(q.id, (q) => ({
    ...q,
    state: "pending",
    snapshot: "/snapshot",
    fingerprint: "hash",
  }));
  return { store, id: q.id };
};
test("requires approval, claims once, retains partial results and never resumes on recovery", async () => {
  const { store, id } = setup();
  let calls = 0;
  const runner = new ConsultationRunner(store, async (_q, a) => {
    calls++;
    if (a.participant.harness === "codex") throw Error("provider failed");
    return { result: "Opinion", usage: null };
  });
  await expect(runner.start(id)).rejects.toThrow("approval_required");
  store.updateConsultation(id, (q) => ({
    ...q,
    state: "approved",
    approvedAt: new Date().toISOString(),
    attempts: q.input.participants.map((p) => newAttempt(p)),
  }));
  await runner.start(id);
  await runner.start(id);
  await runner.settled();
  expect(calls).toBe(2);
  expect(store.getConsultation(id).attempts.map((a) => a.state)).toEqual(["succeeded", "failed"]);
  store.updateConsultation(id, (q) => ({
    ...q,
    state: "running",
    attempts: q.attempts.map((a) => ({ ...a, state: "running" })),
  }));
  runner.recover();
  expect(store.getConsultation(id).attempts.every((a) => a.state === "interrupted")).toBe(true);
  expect(calls).toBe(2);
});
test("cancel aborts all running participants and prevents late success", async () => {
  const { store, id } = setup();
  const runner = new ConsultationRunner(
    store,
    async (_q, _a, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }),
      ),
  );
  store.updateConsultation(id, (q) => ({
    ...q,
    state: "approved",
    attempts: q.input.participants.map((p) => newAttempt(p)),
  }));
  await runner.start(id);
  await runner.cancel(id);
  await runner.settled();
  expect(store.getConsultation(id).state).toBe("cancelled");
  expect(store.getConsultation(id).attempts.every((a) => a.state === "cancelled")).toBe(true);
});
test("native final result and successful exit are both mandatory", () => {
  expect(
    parseResult("claude", '{"type":"result","subtype":"success","result":"ok","is_error":false}', 0)
      .result,
  ).toBe("ok");
  expect(() =>
    parseResult("claude", '{"type":"result","subtype":"success","result":"ok"}', 1),
  ).toThrow();
  expect(() =>
    parseResult(
      "codex",
      '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
      0,
    ),
  ).toThrow();
  // Shape observed from claude 2.1.300 with a cap below the first step's cost.
  expect(() =>
    parseResult(
      "claude",
      '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.0037}',
      1,
    ),
  ).toThrow("budget cap");
  expect(
    parseResult(
      "codex",
      '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}\n{"type":"turn.completed","usage":{"input_tokens":3}}',
      0,
    ).result,
  ).toBe("final");
});
test("a claude consultation keeps the cost it reports and runs under the budget cap", () => {
  const { usage } = parseResult(
    "claude",
    '{"type":"result","subtype":"success","result":"ok","total_cost_usd":0.25,"usage":{"input_tokens":3}}',
    0,
  );
  expect(usage).toEqual({ input_tokens: 3, total_cost_usd: 0.25 });
  const argv = consultationArgs({ harness: "claude", model: "test" }, "question");
  expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe(String(CONSULT_BUDGET_USD));
});
test("read-only adapters cannot inherit bypass, tools or delegation settings", () => {
  const claude = consultationArgs({ harness: "claude", model: "test" }, "question");
  expect(claude).toContain("--restricted");
  expect(claude).toContain("Read,Glob,Grep");
  expect(claude).toContain("--strict-mcp-config");
  const codex = consultationArgs({ harness: "codex", model: "test" }, "question");
  expect(codex).toContain("read-only");
  expect(codex).toContain("--ignore-user-config");
  expect(codex.join(" ")).not.toContain("bypass");
  expect(() => consultationArgs({ harness: "grok", model: "test" }, "question")).toThrow(
    "adapter_unavailable",
  );
});

test("each participant times out without retrying or reporting success", async () => {
  const { store, id } = setup();
  let calls = 0;
  const runner = new ConsultationRunner(store, async (_q, _a, signal) => {
    calls++;
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(Error("deadline")), { once: true }),
    );
  });
  store.updateConsultation(id, (q) => ({
    ...q,
    state: "approved",
    input: { ...q.input, timeoutMs: 10_000 },
    attempts: q.input.participants.map((p) => newAttempt(p)),
  }));
  await runner.start(id);
  await runner.settled();
  expect(store.getConsultation(id).attempts.every((a) => a.state === "timed_out")).toBe(true);
  expect(calls).toBe(2);
}, 15_000);
