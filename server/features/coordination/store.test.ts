import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import { AUDIT_KEPT, CoordinationStore, reservePaths } from "./store.ts";

const setup = () => new CoordinationStore(openDb(":memory:"));
test("messages survive a new store, reuse requests and reject changed duplicate bodies", () => {
  const s = setup();
  const input = { requestId: "request-1", to: "b", text: "Check the API" };
  const m = s.message("a", input);
  expect(s.message("a", input).id).toBe(m.id);
  expect(() => s.message("a", { ...input, text: "Different" })).toThrow("request_conflict");
  s.updateMessage(m.id, "delivered");
  const r = s.message("b", { requestId: "request-2", to: "a", text: "Checked", replyTo: m.id });
  expect(r.threadId).toBe(m.id);
  expect(new CoordinationStore(s.db).messages().find((x) => x.id === m.id)?.status).toBe(
    "answered",
  );
  expect(() =>
    s.message("c", { requestId: "request-3", to: "a", text: "Fake", replyTo: m.id }),
  ).toThrow("reply_owner");
});
test("reservation sets are atomic, idempotent and only their owner may release", () => {
  const s = setup();
  const a = s.reserve("a", "generation-1", "/repo", ["/repo/a"], "API");
  expect(s.reserve("a", "generation-1", "/repo", ["/repo/a"], "API")[0]?.id).toBe(a[0]?.id);
  expect(() => s.reserve("b", "generation-2", "/repo", ["/repo/b", "/repo/a"], "UI")).toThrow(
    "reserved",
  );
  expect(s.reservations()).toHaveLength(1);
  expect(() => s.release("b", a[0]?.id ?? "")).toThrow("reservation_owner");
  s.release("a", a[0]?.id ?? "");
  expect(s.reservations()).toHaveLength(0);
});
test("lost owners remain reserved; confirmed exit releases, resumed generation is orphaned", () => {
  const s = setup();
  s.reserve("a", "first", "/repo", ["/repo/a"], "API");
  s.reconcile([]);
  expect(s.reservations()[0]?.status).toBe("orphaned");
  s.reconcile([{ id: "a", state: "running", startedAt: "second" }]);
  expect(s.reservations()[0]?.status).toBe("orphaned");
  s.reconcile([{ id: "a", state: "exited", startedAt: "second" }]);
  expect(s.reservations()).toHaveLength(1);
  s.reconcile([{ id: "a", state: "exited", startedAt: "first" }]);
  expect(s.reservations()).toHaveLength(0);
});
test("paths resolve aliases and new files but reject escapes and directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-reservation-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "a");
  symlinkSync("src/a.ts", join(root, "alias"));
  symlinkSync(tmpdir(), join(root, "escape"));
  const paths = await reservePaths(root, ["src/a.ts", "alias", "src/new.ts"]);
  expect(paths).toHaveLength(2);
  for (const path of ["../outside", "escape/new.ts", "src", "/etc/passwd", ".git/index"])
    await expect(reservePaths(root, [path])).rejects.toThrow();
});

test("dangling and metadata symlink aliases cannot escape reservation boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-reservation-links-"));
  symlinkSync(join(tmpdir(), `missing-${crypto.randomUUID()}`), join(root, "dangling"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git/index"), "index");
  symlinkSync(".git", join(root, "metadata"));
  for (const path of ["dangling", "dangling/new.ts", "metadata/index"])
    await expect(reservePaths(root, [path])).rejects.toThrow();
});

test("notifications follow commit and failed transactions publish nothing", () => {
  const db = openDb(":memory:");
  const observed: number[] = [];
  const store = new CoordinationStore(db, () => {
    expect(db.inTransaction).toBe(false);
    observed.push(store.revision());
  });
  store.message("user", { requestId: "atomic", to: "a", text: "check" });
  expect(observed).toEqual([1]);
  expect(() => store.message("user", { requestId: "atomic", to: "a", text: "changed" })).toThrow();
  expect(observed).toEqual([1]);
  const reserved = store.reserve("a", "g", "/repo", ["/repo/a"], "change");
  store.release("a", reserved[0]?.id ?? "missing");
  expect(observed).toEqual([1, 2, 3]);
  expect(store.audit()).toHaveLength(1);
  db.close();
});
test("the reservation audit keeps only the newest entries", () => {
  const s = setup();
  for (let i = 0; i < AUDIT_KEPT + 5; i++) {
    const [r] = s.reserve("a", "generation-1", "/repo", [`/repo/f${i}`], "API");
    if (r) s.release("a", r.id);
  }
  const rows = s.db.query<{ n: number }, []>("SELECT count(*) n FROM coordination_audit").get();
  expect(rows?.n).toBe(AUDIT_KEPT);
  expect(s.audit()[0]?.path).toBe(`/repo/f${AUDIT_KEPT + 4}`);
});
