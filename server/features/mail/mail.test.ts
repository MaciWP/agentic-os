import { describe, expect, test } from "bun:test";
import type { ItemResult, ProposalItem } from "../../../shared/mail-sort.ts";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { errorHandler } from "../../errors.ts";
import { saveConnection } from "../../oauth.ts";
import { ProviderError } from "../../provider-error.ts";
import type { GoogleReads } from "../google/routes.ts";
import { macReads } from "../mac/routes.ts";
import { MacError, type MacRunner } from "../mac/run.ts";
import { MemoryError } from "../memory/store.ts";
import { seedSortPrompts, sortPromptBody } from "./prompt.ts";
import { mailRoutes } from "./routes.ts";
import { gmailSide, mailSorter, outlookSide, type Side } from "./sort.ts";
import { ProposalStore } from "./store.ts";

const INBOX = new Map([
  ["a@x.test", { from: "Ana", subject: "Factura" }],
  ["b@x.test", { from: "Luis", subject: null }],
  ["c@x.test", { from: "Promo", subject: "Oferta" }],
]);

// A side whose inbox and dialog the test drives.
function side(over: Partial<Side> = {}) {
  const applied: ProposalItem[][] = [];
  let inbox = INBOX;
  const s: Side = {
    ids: "ids are thread ids",
    extras: true,
    inbox: async () => inbox,
    folders: async () => ["Facturas", "Clientes/ACME"],
    apply: async (items) => {
      applied.push(items);
      return new Map(items.map((i) => [i.id, "ok" as ItemResult]));
    },
    changed: () => {},
    ...over,
  };
  return { side: s, applied, setInbox: (m: typeof INBOX) => (inbox = m) };
}

function setup(over: Partial<Side> = {}) {
  const store = new ProposalStore(openDb(":memory:"));
  const fake = side(over);
  const sorter = mailSorter(store, { work: fake.side, personal: fake.side });
  return { store, sorter, ...fake };
}

const move = (id: string, folder = "Facturas") => ({
  id,
  op: "move" as const,
  folder,
  reason: "r",
});

describe("a proposal", () => {
  test("keeps the inbox's own sender and subject, and replaces the account's last one", async () => {
    const { store, sorter } = setup();
    const first = await sorter.propose("work", { items: [move("a@x.test")] });
    const second = await sorter.propose("work", {
      items: [move("b@x.test"), { id: "c@x.test", op: "trash", reason: "spam" }],
    });
    expect(second.items).toEqual([
      {
        ...move("b@x.test"),
        newFolder: false,
        outside: false,
        from: "Luis",
        subject: null,
        result: null,
      },
      {
        id: "c@x.test",
        op: "trash",
        folder: null,
        newFolder: false,
        outside: false,
        reason: "spam",
        from: "Promo",
        subject: "Oferta",
        result: null,
      },
    ]);
    expect(store.get(first.id).status).toBe("discarded");
    expect(store.pending("work")?.id).toBe(second.id);
    expect(store.pending("personal")).toBeNull();
  });

  test("names every mail not in the inbox and every unknown folder, and saves nothing", async () => {
    const { store, sorter } = setup();
    const err = await sorter
      .propose("work", { items: [move("zz@x.test"), move("a@x.test", "Inbox"), move("b@x.test")] })
      .catch((e) => e);
    expect(err.code).toBe("bad_proposal");
    expect(err.message).toContain("ids are thread ids");
    expect(err.message).toContain("items[0]: zz@x.test is not in the inbox");
    expect(err.message).toContain('items[1]: there is no folder "Inbox"');
    expect(err.message).not.toContain("items[2]");
    expect(store.pending("work")).toBeNull();
  });

  test("names mail read outside the inbox, which is never archived again nor taken as gone", async () => {
    const OLD = new Map([["o1", { from: "Banco", subject: "Extracto" }]]);
    const { store, sorter, applied, setInbox } = setup({
      outside: { read: async () => ({ threads: [], next: null, total: 0 }), seen: () => OLD },
    });
    const err = await sorter
      .propose("personal", { items: [{ id: "o1", op: "archive", reason: "r" }] })
      .catch((e) => e);
    expect(err.message).toContain("items[0]: o1 is already out of the inbox");
    const missing = await sorter.propose("personal", { items: [move("zz")] }).catch((e) => e);
    expect(missing.message).toContain("zz is not in the inbox nor read outside it");
    const p = await sorter.propose("personal", { items: [move("o1"), move("a@x.test")] });
    expect(p.items.map((i) => [i.id, i.from, i.outside])).toEqual([
      ["o1", "Banco", true],
      ["a@x.test", "Ana", false],
    ]);
    setInbox(new Map());
    const done = await sorter.apply(p.id, ["o1", "a@x.test"]);
    expect(applied.map((items) => items.map((i) => i.id))).toEqual([["o1"]]);
    expect(done.items.map((i) => i.result)).toEqual(["ok", "gone"]);
    expect(store.pending("personal")).toBeNull();
    await expect(sorter.outside("work", undefined)).resolves.toBeDefined();
  });

  test("a new folder must not exist yet, and only an account with extras archives or creates", async () => {
    const { sorter } = setup();
    const p = await sorter.propose("personal", {
      items: [
        { ...move("a@x.test", "Viajes"), newFolder: true },
        { id: "b@x.test", op: "archive", reason: "r" },
      ],
    });
    expect(p.items.map((i) => [i.op, i.folder, i.newFolder])).toEqual([
      ["move", "Viajes", true],
      ["archive", null, false],
    ]);
    const err = await sorter
      .propose("personal", { items: [{ ...move("a@x.test"), newFolder: true }] })
      .catch((e) => e);
    expect(err.message).toContain('items[0]: the folder "Facturas" exists; drop newFolder');
    const plain = mailSorter(new ProposalStore(openDb(":memory:")), {
      work: side({ extras: false }).side,
      personal: side().side,
    });
    const refused = await plain
      .propose("work", { items: [{ id: "a@x.test", op: "archive", reason: "r" }] })
      .catch((e) => e);
    expect(refused.message).toContain("items[0]: this account takes no archive and no new folder");
  });
});

describe("applying", () => {
  test("only what the user kept and is still in the inbox; the rest says why", async () => {
    const { store, sorter, applied, setInbox } = setup();
    const p = await sorter.propose("personal", {
      items: [move("a@x.test"), move("b@x.test"), { id: "c@x.test", op: "trash", reason: "spam" }],
    });
    setInbox(new Map([...INBOX].filter(([id]) => id !== "b@x.test")));
    const done = await sorter.apply(p.id, ["a@x.test", "b@x.test"]);
    expect(applied.map((items) => items.map((i) => i.id))).toEqual([["a@x.test"]]);
    expect(done.status).toBe("applied");
    expect(done.items.map((i) => i.result)).toEqual(["ok", "gone", "skipped"]);
    expect(store.pending("personal")).toBeNull();
    await expect(sorter.apply(p.id, ["a@x.test"])).rejects.toMatchObject({ code: "not_pending" });
  });

  test("teaches what the user kept and unticked, by sender, op and folder", async () => {
    const { store, sorter, setInbox } = setup();
    for (let i = 0; i < 2; i++) {
      setInbox(INBOX);
      const p = await sorter.propose("personal", {
        items: [move("a@x.test"), move("b@x.test"), { id: "c@x.test", op: "trash", reason: "s" }],
      });
      setInbox(new Map([...INBOX].filter(([id]) => id !== "b@x.test")));
      await sorter.apply(p.id, ["a@x.test", "b@x.test"]);
    }
    // A discarded proposal and the work account teach nothing about personal mail.
    await sorter.propose("personal", { items: [move("a@x.test")] });
    store.discard((store.pending("personal") as { id: number }).id);
    expect(store.decisions("personal", new Date(0))).toEqual([
      { from: "Ana", op: "move", folder: "Facturas", kept: 2, skipped: 0 },
      { from: "Promo", op: "trash", folder: null, kept: 0, skipped: 2 },
    ]);
    expect(store.decisions("work", new Date(0))).toEqual([]);
    expect(store.decisions("personal", new Date(Date.now() + 60_000))).toEqual([]);
  });

  test("a cancelled dialog leaves it pending; ids outside it are refused", async () => {
    const { store, sorter } = setup({
      apply: async () => {
        throw new MacError("cancelled");
      },
    });
    const p = await sorter.propose("work", { items: [move("a@x.test")] });
    await expect(sorter.apply(p.id, ["a@x.test"])).rejects.toMatchObject({ code: "cancelled" });
    expect(store.get(p.id).status).toBe("pending");
    await expect(sorter.apply(p.id, ["zz@x.test"])).rejects.toMatchObject({ code: "bad_proposal" });
  });

  test("a second click while the dialog is open waits for the first", async () => {
    let click = () => {};
    const { sorter } = setup({
      apply: (items) =>
        new Promise((resolve) => {
          click = () => resolve(new Map(items.map((i) => [i.id, "ok" as ItemResult])));
        }),
    });
    const p = await sorter.propose("work", { items: [move("a@x.test")] });
    const first = sorter.apply(p.id, ["a@x.test"]);
    await Bun.sleep(0);
    await expect(sorter.apply(p.id, ["a@x.test"])).rejects.toMatchObject({ code: "busy" });
    click();
    expect((await first).status).toBe("applied");
  });
});

const outlookMail = (messageId: string, id = "1") => ({
  id,
  messageId,
  subject: "s",
  from: "Ana",
  at: "2026-10-16T08:00:00Z",
  unread: false,
  flagged: false,
});

// A helper with no `stamp` (bad_input): every inbox read is a whole one.
function outlook(answers: (args: string[], input: unknown) => unknown) {
  const inputs: unknown[] = [];
  const run: MacRunner = async (args, _ms, input) => {
    if (input !== undefined) inputs.push(input);
    const answer = args[0] === "stamp" ? new MacError("bad_input") : answers(args, input);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { side: outlookSide(macReads(run)), inputs };
}

const item = (id: string, op: ProposalItem["op"] = "move"): ProposalItem => ({
  id,
  op,
  folder: op === "move" ? "Facturas" : null,
  newFolder: false,
  outside: false,
  reason: "r",
  from: "Ana",
  subject: "s",
  result: null,
});

describe("the Outlook side", () => {
  test("names mail by Message-ID, offers only plain folders, and hands the helper a batch", async () => {
    const { side, inputs } = outlook((args) =>
      args[0] === "inbox"
        ? { total: 1, messages: [outlookMail("a@x.test")] }
        : args[0] === "folders"
          ? {
              folders: [
                { path: "Inbox", role: "inbox", total: 3, senders: [] },
                { path: "Facturas", role: null, total: 9, senders: [] },
              ],
            }
          : { results: [{ messageId: "a@x.test", result: "error -1728" }] },
    );
    expect([...(await side.inbox(false)).keys()]).toEqual(["a@x.test"]);
    expect(await side.folders()).toEqual(["Facturas"]);
    const results = await side.apply([item("a@x.test"), item("b@x.test", "trash")]);
    expect(inputs).toEqual([
      [
        { messageId: "a@x.test", op: "move", folder: "Facturas" },
        { messageId: "b@x.test", op: "trash", folder: "" },
      ],
    ]);
    expect(results.get("a@x.test")).toBe("error");
  });

  test("a timeout reads the inbox again: what left it is unknown, and if none did, it failed", async () => {
    let inbox = [outlookMail("b@x.test")];
    const { side } = outlook((args) =>
      args[0] === "inbox" ? { total: inbox.length, messages: inbox } : new MacError("timeout"),
    );
    const results = await side.apply([item("a@x.test"), item("b@x.test")]);
    expect(Object.fromEntries(results)).toEqual({ "a@x.test": "unknown", "b@x.test": "error" });
    inbox = [outlookMail("a@x.test"), outlookMail("b@x.test", "2")];
    await expect(side.apply([item("a@x.test")])).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("the Gmail side", () => {
  const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
  function gmail(scopes: string, sort: (id: string, to: object) => Promise<void> = async () => {}) {
    const db = openDb(":memory:");
    saveConnection(db, "google", { accountId: "me@x.test", displayName: "me", scopes });
    const calls: { confirm: unknown[]; sorted: [string, object][]; created: string[] } = {
      confirm: [],
      sorted: [],
      created: [],
    };
    const reads = {
      client: {
        labels: async () => [{ id: "Label_1", name: "Facturas" }],
        createLabel: async (name: string) => {
          calls.created.push(name);
          if (name === "Roto") throw new ProviderError("google", 400, "invalid label name");
          return `Label_new_${name}`;
        },
        sortThread: async (id: string, to: object) => {
          calls.sorted.push([id, to]);
          await sort(id, to);
        },
      },
    } as unknown as GoogleReads;
    const confirm = async (batch: unknown) => {
      calls.confirm.push(batch);
    };
    return { side: gmailSide(reads, confirm, db), calls };
  }

  test("without gmail.modify it asks for a reconnect before any dialog", async () => {
    const { side, calls } = gmail("https://www.googleapis.com/auth/gmail.readonly");
    await expect(side.apply([item("t1")])).rejects.toMatchObject({ provider: "google" });
    expect(calls.confirm).toEqual([]);
  });

  test("after the click: a label by its id and out of the inbox, the trash, and what failed", async () => {
    const { side, calls } = gmail(`x ${MODIFY}`, async (id) => {
      if (id === "t3") throw new ProviderError("google", 404, "gone");
    });
    const results = await side.apply([
      item("t1"),
      item("t2", "trash"),
      item("t3"),
      { ...item("t4"), folder: "Borrada" },
    ]);
    expect(calls.confirm).toHaveLength(1);
    expect(calls.sorted).toEqual([
      ["t1", { labelId: "Label_1" }],
      ["t2", { trash: true }],
      ["t3", { labelId: "Label_1" }],
    ]);
    expect(Object.fromEntries(results)).toEqual({
      t1: "ok",
      t2: "ok",
      t3: "not_found",
      t4: "no_folder",
    });
  });

  test("creates the new labels it was shown, archives, and a label it cannot make moves nothing", async () => {
    const { side, calls } = gmail(`x ${MODIFY}`);
    const results = await side.apply([
      { ...item("t1"), folder: "Viajes", newFolder: true },
      { ...item("t2"), folder: "Viajes", newFolder: true },
      item("t3", "archive"),
      { ...item("t4"), folder: "Roto", newFolder: true },
    ]);
    expect(calls.confirm).toEqual([
      [
        { messageId: "t1", op: "move", folder: "Viajes (carpeta nueva)" },
        { messageId: "t2", op: "move", folder: "Viajes (carpeta nueva)" },
        { messageId: "t3", op: "move", folder: "Archivar (quitar de la bandeja)" },
        { messageId: "t4", op: "move", folder: "Roto (carpeta nueva)" },
      ],
    ]);
    expect(calls.created).toEqual(["Viajes", "Roto"]);
    expect(calls.sorted).toEqual([
      ["t1", { labelId: "Label_new_Viajes" }],
      ["t2", { labelId: "Label_new_Viajes" }],
      ["t3", { archive: true }],
    ]);
    expect(Object.fromEntries(results)).toEqual({ t1: "ok", t2: "ok", t3: "ok", t4: "no_folder" });
  });

  test("Gmail refusing every move for its scope is a reconnect, not a list of errors", async () => {
    const { side } = gmail(MODIFY, async () => {
      throw new ProviderError("google", 403, "no", "insufficientPermissions");
    });
    await expect(side.apply([item("t1")])).rejects.toMatchObject({ provider: "google" });
  });
});

describe("the routes", () => {
  function app(providers = { outlook: true, google: true }) {
    const { store, sorter } = setup();
    const config = ConfigSchema.parse({ providers });
    const json = (body: unknown, headers: Record<string, string> = {}) => ({
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      store,
      json,
      app: mailRoutes({ config, proposals: store, sorter }).onError(errorHandler(SERVER_ERRORS)),
    };
  }

  test("an agent proposes; a bad body or an off provider is refused", async () => {
    const { app: a, json } = app();
    const res = await a.request("/work/proposals", json({ items: [move("a@x.test")] }));
    expect(res.status).toBe(200);
    expect((await (await a.request("/work/proposal")).json()).proposal.items).toHaveLength(1);
    expect(await (await a.request("/work/decisions")).json()).toEqual({ decisions: [] });
    expect((await a.request("/elsewhere/decisions")).status).toBe(404);
    const twice = await a.request(
      "/work/proposals",
      json({ items: [move("a@x.test"), move("a@x.test")] }),
    );
    expect(twice.status).toBe(400);
    const noFolder = await a.request(
      "/work/proposals",
      json({ items: [{ id: "a@x.test", op: "move", reason: "r" }] }),
    );
    expect(noFolder.status).toBe(400);
    expect((await a.request("/elsewhere/proposal")).status).toBe(404);
    const off = await app({ outlook: false, google: true }).app.request(
      "/work/proposals",
      json({ items: [move("a@x.test")] }),
    );
    expect([off.status, (await off.json()).error]).toEqual([400, "provider_disabled"]);
  });

  test("a call that names an agent cannot apply; the user can, and can discard", async () => {
    const { app: a, json, store } = app();
    const p = (
      await (await a.request("/personal/proposals", json({ items: [move("a@x.test")] }))).json()
    ).proposal;
    const agent = await a.request(
      `/proposals/${p.id}/apply`,
      json({ keep: ["a@x.test"] }, { "x-aos-agent-id": "t1" }),
    );
    expect([agent.status, (await agent.json()).error]).toEqual([403, "user_approval_required"]);
    // The dialog outlasts Bun's idle timeout, so the request lifts it for itself.
    const held: number[] = [];
    const server = { timeout: (_req: Request, seconds: number) => held.push(seconds) };
    const applied = await a.request(
      `/proposals/${p.id}/apply`,
      json({ keep: ["a@x.test"] }),
      server,
    );
    expect((await applied.json()).proposal.items[0].result).toBe("ok");
    expect(held).toEqual([0]);
    const again = await a.request("/personal/proposals", json({ items: [move("b@x.test")] }));
    const next = (await again.json()).proposal;
    expect((await a.request(`/proposals/${next.id}/discard`, json({}))).status).toBe(200);
    expect(store.pending("personal")).toBeNull();
    expect((await a.request(`/proposals/${next.id}/discard`, json({}))).status).toBe(409);
  });
});

describe("the categorizer prompts", () => {
  // A prompts folder in memory: create refuses a name it has, update needs the current mtime.
  function folder() {
    const docs = new Map<string, { body: string; mtime: number }>();
    const memory = {
      create: async (source: string, name: string, body: string) => {
        const id = `${source}:${name}.md`;
        if (docs.has(id)) throw new MemoryError(409, "exists", name);
        docs.set(id, { body, mtime: 1 });
        return { id };
      },
      get: async (id: string) => ({ id, ...(docs.get(id) as { body: string; mtime: number }) }),
      update: async (id: string, body: string, mtime: number) => {
        expect(docs.get(id)?.mtime).toBe(mtime);
        docs.set(id, { body, mtime: mtime + 1 });
        return { id };
      },
    };
    return { docs, memory: memory as never };
  }
  const WORK = "prompts:Categorizar Trabajo.md";
  const PERSONAL = "prompts:Categorizar Personal.md";

  test("are seeded once each, with the absolute aos path", async () => {
    const { docs, memory } = folder();
    await seedSortPrompts(memory, "/app");
    await seedSortPrompts(memory, "/app");
    expect([...docs.keys()]).toEqual([WORK, PERSONAL]);
    expect(docs.get(WORK)?.mtime).toBe(1);
    const work = docs.get(WORK)?.body;
    expect(work).toContain('"/app/bin/aos" mail propose work --input-file');
    expect(work).toContain('"/app/bin/aos" mail decisions work');
    expect(work).toContain('Do not propose "trash"');
    expect(work).toMatch(/\nseeded: [0-9a-f]{16}\n---\n/);
    expect(sortPromptBody("personal", "/app")).toContain("correspondents");
  });

  test("follow this code while the user has not edited them, and never overwrite an edit", async () => {
    const { docs, memory } = folder();
    await seedSortPrompts(memory, "/old");
    const edited = `${docs.get(PERSONAL)?.body}`.replace("Never trash", "Never bin");
    docs.set(PERSONAL, { body: edited, mtime: 5 });
    // A prompt seeded before the stamp counts as edited: there is no proof it was not.
    docs.set(WORK, { body: sortPromptBody("work", "/old"), mtime: 7 });
    await seedSortPrompts(memory, "/new");
    expect(docs.get(PERSONAL)?.body).toBe(edited);
    expect(docs.get(WORK)?.body).toBe(sortPromptBody("work", "/old"));
    const { docs: fresh, memory: m2 } = folder();
    await seedSortPrompts(m2, "/old");
    await seedSortPrompts(m2, "/new");
    expect(fresh.get(WORK)?.body).toContain('"/new/bin/aos"');
    expect(fresh.get(WORK)?.mtime).toBe(2);
  });
});
