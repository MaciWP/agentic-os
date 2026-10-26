import { describe, expect, test } from "bun:test";
import { createPendingStore } from "./pending.ts";

function setup() {
  const answers: { resolve: (text: string) => void; reject: (err: Error) => void }[] = [];
  const sent: [string, string][] = [];
  let sendError: Error | null = null;
  let changes = 0;
  const store = createPendingStore({
    transcribe: () =>
      new Promise<string>((resolve, reject) => {
        answers.push({ resolve, reject });
      }),
    send: async (terminal, text) => {
      if (sendError) throw sendError;
      sent.push([terminal, text]);
    },
    message: (err) => (err instanceof Error ? err.message : String(err)),
  });
  store.subscribe(() => changes++);
  return {
    store,
    answers,
    sent,
    failSend: (err: Error) => {
      sendError = err;
    },
    changes: () => changes,
  };
}
const pcm = new Int16Array(4);

describe("pending dictations", () => {
  test("the text reaches its terminal with no view waiting for it", async () => {
    const { store, answers, sent } = setup();
    const done = store.transcribe("t1", pcm);
    expect(store.get("t1").run).not.toBeNull();
    expect(store.get("t2").run).toBeNull();
    answers[0]?.resolve("  hola mundo ");
    expect(await done).toEqual({ outcome: "done", text: "hola mundo" });
    expect(sent).toEqual([["t1", "hola mundo "]]);
    expect(store.get("t1")).toEqual({ run: null, error: null });
  });

  test("tells the views when the wait starts and ends", async () => {
    const { store, answers, changes } = setup();
    const done = store.transcribe("t1", pcm);
    expect(changes()).toBe(1);
    answers[0]?.resolve("hola");
    await done;
    expect(changes()).toBe(2);
  });

  test("a cancel before the text comes back sends nothing", async () => {
    const { store, answers, sent } = setup();
    const done = store.transcribe("t1", pcm);
    store.cancel("t1");
    expect(store.get("t1").run).toBeNull();
    answers[0]?.resolve("hola");
    expect(await done).toEqual({ outcome: "cancelled" });
    expect(sent).toEqual([]);
  });

  test("a newer dictation in the same terminal replaces the older one", async () => {
    const { store, answers, sent } = setup();
    const older = store.transcribe("t1", pcm);
    const newer = store.transcribe("t1", pcm);
    answers[0]?.resolve("viejo");
    expect(await older).toEqual({ outcome: "cancelled" });
    answers[1]?.resolve("nuevo");
    await newer;
    expect(sent).toEqual([["t1", "nuevo "]]);
  });

  test("silence sends nothing and ends the wait", async () => {
    const { store, answers, sent } = setup();
    const done = store.transcribe("t1", pcm);
    answers[0]?.resolve("   ");
    expect(await done).toEqual({ outcome: "done", text: "" });
    expect(sent).toEqual([]);
    expect(store.get("t1").run).toBeNull();
  });

  test("a terminal that ended keeps the failure until a view shows it once", async () => {
    const { store, answers, failSend } = setup();
    failSend(new Error("el terminal ya no está en marcha"));
    const done = store.transcribe("t1", pcm);
    answers[0]?.resolve("hola");
    expect(await done).toEqual({ outcome: "failed", message: "el terminal ya no está en marcha" });
    expect(store.get("t1")).toEqual({ run: null, error: "el terminal ya no está en marcha" });
    expect(store.takeError("t1")).toBe("el terminal ya no está en marcha");
    expect(store.takeError("t1")).toBeNull();
  });

  test("a failed transcription is kept, but not once cancelled", async () => {
    const { store, answers } = setup();
    const failed = store.transcribe("t1", pcm);
    answers[0]?.reject(new Error("model crashed"));
    expect(await failed).toEqual({ outcome: "failed", message: "model crashed" });
    expect(store.takeError("t1")).toBe("model crashed");

    const dropped = store.transcribe("t1", pcm);
    store.cancel("t1");
    answers[1]?.reject(new Error("model crashed"));
    expect(await dropped).toEqual({ outcome: "cancelled" });
    expect(store.takeError("t1")).toBeNull();
  });
});
