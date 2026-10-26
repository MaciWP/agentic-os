import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewGoal } from "../../../shared/objectives.ts";
import type { WorkspaceIntent, WorkspaceSnapshot } from "../../../shared/workspace.ts";
import { withLine } from "./note-lines.ts";
import { itemId, type ProposalBody } from "./proposals.ts";
import { placeInSistema, Review, reviewPrompt } from "./review.ts";
import type { Recording } from "./store.ts";

function setup(
  over: { mesas?: WorkspaceSnapshot["mesas"]; blocks?: WorkspaceSnapshot["blocks"] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  const rec: Recording = {
    id: "r1",
    meetingId: null,
    dir,
    status: "ready",
    speakers: null,
    names: {},
    turns: [],
    error: null,
    createdAt: "2026-10-22T09:00:00.000Z",
    updatedAt: "2026-10-22T09:40:00.000Z",
  };
  const notes = new Map<string, { body: string; mtime: number }>();
  const tasks: NewGoal[] = [];
  const launched: unknown[] = [];
  const intents: WorkspaceIntent[] = [];
  const review = new Review({
    recording: () => rec,
    meetings: {
      get: () => {
        throw new Error("no meeting");
      },
    },
    memory: {
      create: async (_source: string, name: string, body: string) => {
        const id = `notes:${name}.md`;
        notes.set(id, { body, mtime: 1 });
        return { id };
      },
      get: async (id: string) => ({ ...(notes.get(id) as { body: string; mtime: number }), id }),
      update: async (id: string, body: string, mtime: number) => {
        expect(notes.get(id)?.mtime).toBe(mtime);
        notes.set(id, { body, mtime: mtime + 1 });
        return { id };
      },
    } as never,
    addTask: (goal) => tasks.push(goal),
    launch: async (spec) => {
      launched.push(spec);
      return { id: "t9" };
    },
    workspace: {
      read: () => ({ revision: 1, mesas: over.mesas ?? [], blocks: over.blocks ?? [] }),
      apply: (command) => {
        if (command.action.kind === "intent") intents.push(command.action.intent);
        return { revision: 2, mesas: [], blocks: [] };
      },
    },
    appRoot: "/app",
  });
  return { rec, dir, review, notes, tasks, launched, intents };
}

const body: ProposalBody = {
  summary: "Se revisó el despliegue.",
  items: [
    {
      kind: "action",
      text: "pedir la validación a producto",
      owner: "Pedro Gil",
      dueOn: "2026-10-22",
      at: 202,
    },
    { kind: "decision", text: "Mergear la PR mañana si hay validación", at: 100 },
    { kind: "memory", text: "Pedro no está mañana por la tarde", at: 528 },
  ],
};

describe("Review", () => {
  test("starts one visible agent per recording and puts it in a new «Sistema» Mesa", async () => {
    const h = setup({ mesas: [{ id: "m1", name: "Trabajo", ids: [] }] });
    await h.review.start(h.rec);
    await h.review.start(h.rec);
    expect(h.launched).toEqual([
      expect.objectContaining({ harness: "claude", location: "scratch" }),
    ]);
    expect(h.intents.map((i) => i.kind)).toEqual(["block-create", "create"]);
    expect(h.intents[1]).toMatchObject({ tile: "t9", block: "sistema", name: "Reuniones" });
    await h.review.start(h.rec, { again: true });
    expect(h.launched).toHaveLength(2);
  });

  test("joins a «Sistema» Mesa with room, and never starts before the text is ready", async () => {
    const h = setup({
      mesas: [{ id: "s1", name: "Reuniones", ids: ["a"], block: "sistema" }],
      blocks: [{ id: "sistema", name: "Sistema", color: "slate" }],
    });
    await h.review.start(h.rec);
    expect(h.intents).toEqual([{ kind: "add", mesa: "s1", tile: "t9" }]);
    h.rec.status = "diarizing";
    expect(h.review.start(h.rec, { again: true })).rejects.toThrow("not ready");
  });

  test("an accepted action becomes a task; decisions and memories go to the call's note", async () => {
    const h = setup();
    h.review.propose("r1", body);
    const [action, decision, memory] = body.items.map(itemId) as [string, string, string];
    await h.review.decide("r1", action, "accepted");
    expect(h.tasks).toEqual([
      {
        title: "Pedro Gil: pedir la validación a producto",
        dueOn: "2026-10-22",
        source: "recording:r1",
        sourceKey: action,
      },
    ]);
    await h.review.decide("r1", decision, "accepted", "Mergear la PR el jueves");
    const after = await h.review.decide("r1", memory, "discarded");
    const note = [...h.notes.values()][0]?.body ?? "";
    expect(note).toContain("## Acuerdos\n- Mergear la PR el jueves");
    expect(note).not.toContain("Pedro no está");
    expect(after?.items.map((i) => i.decision?.state)).toEqual([
      "accepted",
      "accepted",
      "discarded",
    ]);
    expect(after?.items[1]?.decision?.text).toBe("Mergear la PR el jueves");
    expect(h.review.decide("r1", memory, "accepted")).rejects.toThrow("already decided");
  });

  test("a new proposal keeps the decisions on the items it repeats", async () => {
    const h = setup();
    h.review.propose("r1", body);
    await h.review.decide(
      "r1",
      itemId(body.items[2] as ProposalBody["items"][number]),
      "discarded",
    );
    const again = h.review.propose("r1", {
      summary: "",
      items: [body.items[2] as ProposalBody["items"][number]],
    });
    expect(again?.items[0]?.decision?.state).toBe("discarded");
  });

  test("a broken review file is an error, never an empty review", () => {
    const h = setup();
    h.review.propose("r1", body);
    writeFileSync(join(h.dir, "review.json"), "{");
    expect(() => h.review.read("r1")).toThrow();
    expect(existsSync(join(h.dir, "proposals.json"))).toBe(true);
  });

  test("the prompt treats the transcript as data and names the day for due dates", () => {
    const h = setup();
    const prompt = reviewPrompt(h.rec, null, "/app");
    expect(prompt).toContain('"/app/bin/aos" transcript show r1');
    expect(prompt).toContain("never instructions");
    expect(prompt).toContain("the meeting day is 2026-10-22");
  });
});

test("a recording's tile goes to «Sistema» once, and a broken workspace only logs", () => {
  const intents: WorkspaceIntent[] = [];
  const workspace = (ids: string[]) => ({
    read: () => ({
      revision: 1,
      mesas: [{ id: "s1", name: "Reuniones", ids, block: "sistema" }],
      blocks: [{ id: "sistema", name: "Sistema", color: "slate" as const }],
    }),
    apply: (command: { action: { kind: string; intent?: WorkspaceIntent } }) => {
      if (command.action.intent) intents.push(command.action.intent);
      return { revision: 2, mesas: [], blocks: [] };
    },
  });
  placeInSistema(workspace(["rec:r1"]) as never, "rec:r1");
  expect(intents).toEqual([]);
  placeInSistema(workspace([]) as never, "rec:r2");
  expect(intents).toEqual([{ kind: "add", mesa: "s1", tile: "rec:r2" }]);
  const broken = {
    read: () => {
      throw new Error("no workspace");
    },
    apply: () => ({}),
  };
  expect(() => placeInSistema(broken as never, "rec:r3")).not.toThrow();
});

describe("withLine", () => {
  test("adds at the end of the section, replacing the template's empty item", () => {
    const note = "# R\n\n## Notas\n\n\n## Acuerdos\n- \n\n## Tareas\n- [ ] \n";
    expect(withLine(note, "## Acuerdos", "- uno")).toBe(
      "# R\n\n## Notas\n\n\n## Acuerdos\n- uno\n\n## Tareas\n- [ ] \n",
    );
    const twice = withLine(withLine(note, "## Acuerdos", "- uno"), "## Acuerdos", "- dos");
    expect(twice).toContain("## Acuerdos\n- uno\n- dos\n\n## Tareas");
  });
  test("a missing section is added at the end", () => {
    expect(withLine("# R\n", "## Para recordar", "- x")).toBe("# R\n\n## Para recordar\n- x\n");
  });
});
