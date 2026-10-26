import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { SharedMesa, WorkspaceCommand } from "../../../shared/workspace.ts";
import {
  changeMesas,
  moveTerminal,
  openInMesa,
  readMesas,
  updateMesa,
  writeMembership,
} from "./mesas.ts";
import {
  discardWorkspace,
  receive,
  retryWorkspace,
  sendIntent,
  workspaceSync,
} from "./workspace-sync.tsx";

const start: SharedMesa[] = [
  { id: "a", name: "A", ids: ["t1"] },
  { id: "b", name: "B", ids: [] },
];
const members = () => readMesas().mesas.map((m) => [m.id, m.ids]);
// The fetch mock answers each POST in turn with the next handler.
let answers: ((command: WorkspaceCommand) => Response | Promise<Response>)[] = [];
const posted: WorkspaceCommand[] = [];
let fetchSpy: Mock<typeof fetch>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  answers = [];
  posted.length = 0;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: string,
    init?: RequestInit,
  ) => {
    const command = JSON.parse(String(init?.body)) as WorkspaceCommand;
    posted.push(command);
    const answer = answers.shift();
    if (!answer) throw new Error("no answer prepared");
    return answer(command);
  }) as unknown as typeof fetch);
  workspaceSync.set({ ready: false, sending: 0, error: null, unconfirmed: [], remote: null });
  writeMembership(() => ({
    version: 1,
    activeId: "a",
    mesas: start.map((m) => ({ ...m, ids: [...m.ids], layout: null })),
  }));
  await receive({ revision: 1, mesas: start, blocks: [] });
});
// Back to one empty «Mesa 1», as a fresh browser starts, for the files that run next.
afterEach(() => {
  fetchSpy.mockRestore();
  writeMembership(() => ({
    version: 1,
    activeId: "mesa-1",
    mesas: [{ id: "mesa-1", name: "Mesa 1", ids: [], layout: null }],
  }));
});

test("a request names one tile and one intent; the answer decides what shows", async () => {
  answers.push(() =>
    json(200, { revision: 2, mesas: [{ ...start[0], ids: ["t1", "t2"] }, start[1]] }),
  );
  sendIntent({ kind: "add", mesa: "a", tile: "t2" }, (s) => openInMesa(s, "t2", "a"));
  // Shown at once, before the answer.
  expect(members()).toEqual([
    ["a", ["t1", "t2"]],
    ["b", []],
  ]);
  await settled();
  expect(posted).toHaveLength(1);
  expect(posted[0]?.action).toEqual({
    kind: "intent",
    intent: { kind: "add", mesa: "a", tile: "t2" },
  });
  expect(JSON.stringify(posted[0])).not.toContain('"ids"');
  expect(workspaceSync.get()).toMatchObject({ error: null, remote: { revision: 2 } });
});

test("a refusal says where the terminal is and puts the server's Mesas back", async () => {
  const current = { revision: 3, mesas: [start[0], { ...start[1], ids: ["t9"] }] };
  answers.push(() => json(409, { error: "terminal_elsewhere", detail: "x", current }));
  sendIntent({ kind: "add", mesa: "a", tile: "t9" }, (s) => openInMesa(s, "t9", "a"));
  await settled();
  expect(workspaceSync.get().error).toBe("La terminal ya estaba en «B».");
  expect(workspaceSync.get().unconfirmed).toEqual([]);
  expect(members()).toEqual([
    ["a", ["t1"]],
    ["b", ["t9"]],
  ]);
});

test("a lost answer stays shown as unconfirmed; the retry sends the same id", async () => {
  answers.push(() => {
    throw new TypeError("network");
  });
  sendIntent({ kind: "move", mesa: "b", tile: "t1" }, (s) => moveTerminal(s, "t1", "b"));
  await settled();
  expect(workspaceSync.get().error).toContain("No se ha confirmado el cambio");
  expect(workspaceSync.get().unconfirmed.map((u) => u.label)).toEqual([
    "Llevar una terminal a «B»",
  ]);
  // Nothing goes to storage for a later replay; the change stays on screen meanwhile.
  expect(members()).toEqual([
    ["a", []],
    ["b", ["t1"]],
  ]);
  answers.push(() =>
    json(200, {
      revision: 2,
      mesas: [
        { ...start[0], ids: [] },
        { ...start[1], ids: ["t1"] },
      ],
    }),
  );
  let readAgain = 0;
  retryWorkspace(() => readAgain++);
  await settled();
  expect(posted).toHaveLength(2);
  expect(posted[1]?.requestId).toBe(posted[0]?.requestId ?? "");
  expect(readAgain).toBe(0);
  expect(workspaceSync.get()).toMatchObject({ error: null, unconfirmed: [] });
});

test("giving up an unconfirmed request shows the server's Mesas", async () => {
  answers.push(() => json(500, { error: "internal" }));
  sendIntent({ kind: "remove", mesa: "a", tile: "t1" }, (s) => updateMesa(s, "a", { ids: [] }));
  await settled();
  expect(members()).toEqual([
    ["a", []],
    ["b", []],
  ]);
  let readAgain = 0;
  discardWorkspace(() => readAgain++);
  expect(readAgain).toBe(1);
  expect(members()).toEqual([
    ["a", ["t1"]],
    ["b", []],
  ]);
});

test("an answer waits for the requests still on their way, so it never undoes them", async () => {
  // The server applied the second request first: its answer (revision 2) has no t2 yet.
  let release = () => {};
  answers.push(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            json(200, {
              revision: 3,
              mesas: [
                { ...start[0], ids: ["t1", "t2"] },
                { ...start[1], ids: ["t3"] },
              ],
            }),
          );
      }),
    () => json(200, { revision: 2, mesas: [start[0], { ...start[1], ids: ["t3"] }] }),
  );
  sendIntent({ kind: "add", mesa: "a", tile: "t2" }, (s) => openInMesa(s, "t2", "a"));
  sendIntent({ kind: "add", mesa: "b", tile: "t3" }, (s) => openInMesa(s, "t3", "b"));
  await settled();
  // The second answer came first; it does not undo the first change, still on its way.
  expect(members()).toEqual([
    ["a", ["t1", "t2"]],
    ["b", ["t3"]],
  ]);
  release();
  await settled();
  expect(workspaceSync.get().remote?.revision).toBe(3);
  expect(members()).toEqual([
    ["a", ["t1", "t2"]],
    ["b", ["t3"]],
  ]);
});

test("a view change never changes membership: layout, maximise, tab order", () => {
  changeMesas((s) => updateMesa(s, "a", { ids: [], layout: null, max: "t1" }));
  changeMesas((s) => ({ ...s, mesas: [...s.mesas].reverse().slice(0, 1) }));
  expect(readMesas().mesas.map((m) => [m.id, m.ids, m.max])).toEqual([
    ["b", [], undefined],
    ["a", ["t1"], "t1"],
  ]);
  expect(posted).toEqual([]);
});
