import { expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { Messenger } from "./messages.ts";
import { CoordinationStore } from "./store.ts";

test("concurrent messages serialize text/enter and duplicate requests never type twice", async () => {
  const store = new CoordinationStore(openDb(":memory:"));
  const writes: string[] = [];
  const messenger = new Messenger(
    store,
    {
      get: async () => ({ state: "running", harness: "claude" }),
      write: async (_id, data) => {
        writes.push(data);
        await Bun.sleep(1);
        return true;
      },
    },
    1,
  );
  const a = store.message("a", { requestId: "1", to: "b", text: "First" });
  const b = store.message("a", { requestId: "2", to: "b", text: "Second" });
  await Promise.all([messenger.deliver(a.id), messenger.deliver(b.id), messenger.deliver(a.id)]);
  expect(writes).toHaveLength(4);
  expect(writes[0]).toContain("First");
  expect(writes[1]).toBe("\r");
  expect(writes[2]).toContain("Second");
  expect(writes[3]).toBe("\r");
  expect(store.getMessage(a.id).status).toBe("delivered");
});
test("a write followed by transport failure is uncertain and is not repeated", async () => {
  const store = new CoordinationStore(openDb(":memory:"));
  let calls = 0;
  const messenger = new Messenger(
    store,
    {
      get: async () => ({ state: "running", harness: "codex" }),
      write: async () => {
        if (++calls === 2) throw new Error("connection lost");
        return true;
      },
    },
    0,
  );
  const m = store.message("a", { requestId: "1", to: "b", text: "Hello" });
  await messenger.deliver(m.id);
  await messenger.deliver(m.id);
  expect(store.getMessage(m.id).status).toBe("uncertain");
  expect(calls).toBe(2);
});
