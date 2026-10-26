import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Io, run } from "./aos.ts";

type Seen = { method: string; path: string; headers: Headers; body: unknown };

describe("aos CLI", () => {
  const seen: Seen[] = [];
  // Replies the fake server gives to waits, in order.
  let waits: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let env: Record<string, string>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? undefined : await req.json();
        seen.push({
          method: req.method,
          path: url.pathname + url.search,
          headers: req.headers,
          body,
        });
        if (url.pathname.includes("/nope"))
          return Response.json({ error: "not_found" }, { status: 404 });
        if (url.pathname.endsWith("/wait"))
          return Response.json({ reason: waits.shift() ?? "idle", seq: 7, state: "running" });
        if (url.pathname.endsWith("/text"))
          return Response.json({ text: "line 1\nline 2", seq: 7, state: "running" });
        if (url.pathname === "/api/terminals" && req.method === "POST")
          return Response.json({ terminal: { id: "t1" } }, { status: 201 });
        return Response.json({ terminals: [{ id: "t1" }] });
      },
    });
    env = { AOS_URL: `http://localhost:${server.port}` };
  });
  afterAll(() => server.stop(true));

  const aos = async (args: string[], files: Record<string, string> = {}) => {
    seen.length = 0;
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      readFile: (path) => files[path] ?? "",
    };
    const code = await run(args, env, io);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  test("create sends the prompt file's text, model and effort, with the app's Origin", async () => {
    const r = await aos(
      [
        "create",
        "--harness",
        "codex",
        "--location",
        "app",
        "--prompt-file",
        "brief.md",
        "--model",
        "m1",
        "--effort",
        "high",
      ],
      { "brief.md": "Review this" },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ id: "t1" });
    const [call] = seen;
    expect(call?.body).toEqual({
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      harness: "codex",
      location: "app",
      prompt: "Review this",
      model: "m1",
      effort: "high",
    });
    expect(call?.headers.get("origin")).toBe(env.AOS_URL);
    expect(call?.headers.get("content-type")).toBe("application/json");
  });

  test("read prints JSON, or only the text with --plain", async () => {
    expect(JSON.parse((await aos(["read", "t1"])).out)).toMatchObject({ seq: 7 });
    const plain = await aos(["read", "t1", "--lines", "50", "--plain"]);
    expect(plain.out).toBe("line 1\nline 2");
    expect(seen[0]?.path).toBe("/api/terminals/t1/text?lines=50");
  });

  test("send passes the text and its flags", async () => {
    const r = await aos(["send", "t1", "--text-file", "-", "--enter", "--interrupt"], {
      "-": "hi",
    });
    expect(r.code).toBe(0);
    expect(seen[0]?.body).toEqual({ text: "hi", enter: true, interrupt: true });
  });

  test("a wait past the server's cap is several waits; one that runs out exits 3", async () => {
    waits = ["timeout", "idle"];
    const long = await aos(["wait", "t1", "--after", "3", "--timeout-ms", "150000"]);
    expect(long.code).toBe(0);
    expect(seen.map((s) => s.body)).toEqual([
      { after: 3, timeoutMs: 100_000 },
      { after: 3, timeoutMs: 50_000 },
    ]);
    waits = ["timeout"];
    const short = await aos(["wait", "t1", "--timeout-ms", "100"]);
    expect(short.code).toBe(3);
    expect(JSON.parse(short.out)).toMatchObject({ reason: "timeout" });
    expect(seen).toHaveLength(1);
  });

  test("--until keeps waiting past quiet output until the text shows, or the terminal exits", async () => {
    waits = ["idle"];
    const found = await aos(["wait", "t1", "--until", "line 2"]);
    expect(found.code).toBe(0);
    expect(JSON.parse(found.out)).toMatchObject({ reason: "idle", found: true });
    expect(seen.map((s) => s.path)).toEqual([
      "/api/terminals/t1/wait",
      "/api/terminals/t1/text?lines=2000",
    ]);

    // Quiet twice without the text: the second wait asks for output newer than the first.
    waits = ["idle", "exit"];
    const gone = await aos(["wait", "t1", "--after", "1", "--until", "DONE_0"]);
    expect(gone.code).toBe(3);
    expect(JSON.parse(gone.out)).toMatchObject({ reason: "exit", found: false });
    const bodies = seen.filter((s) => s.path.endsWith("/wait")).map((s) => s.body);
    expect(bodies).toMatchObject([{ after: 1 }, { after: 7 }]);
  });

  test("server errors exit 1 and usage errors exit 2, both on stderr", async () => {
    const missing = await aos(["read", "nope"]);
    expect(missing).toMatchObject({ code: 1, out: "" });
    expect(missing.err).toContain("404 not_found");
    for (const args of [
      ["frobnicate"],
      ["send"],
      ["read", "a", "b"],
      ["read", "t1", "--lines", "abc"],
      ["list", "--bogus"],
      ["create", "--harness", "shell"],
      ["send", "t1", "--text", "a", "--text-file", "f"],
    ]) {
      const r = await aos(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("usage:");
    }
    expect(seen).toHaveLength(0);
  });

  test("--machine sends terminal commands through the hub's door; notes stay here", async () => {
    const send = await aos(["send", "t1", "--machine", "win", "--text", "hola"]);
    expect([send.code, seen.map((r) => r.path)]).toEqual([
      0,
      ["/api/machines/win/terminals/t1/send"],
    ]);
    // A long wait through the hub goes in slices under its relay deadline.
    const wait = await aos(["wait", "t1", "--machine", "win", "--timeout-ms", "120000"]);
    expect(wait.code).toBe(0);
    expect(seen.map((r) => (r.body as { timeoutMs: number }).timeoutMs)).toEqual([50_000]);
    const list = await aos(["list", "--machine", "win"]);
    expect([list.code, seen.map((r) => r.path)]).toEqual([0, ["/api/machines/win/terminals"]]);
    const notes = await aos(["notes", "search", "x", "--machine", "win"]);
    expect([notes.code, seen.length]).toEqual([2, 0]);
    expect(notes.err).toContain("--machine works with");
  });

  test("an unreachable server is an error, not a hang", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = `http://localhost:${probe.port}`;
    probe.stop(true);
    const err: string[] = [];
    const code = await run(
      ["list"],
      { AOS_URL: url },
      {
        out: () => {},
        err: (s) => err.push(s),
        readFile: () => "",
      },
    );
    expect(code).toBe(1);
    expect(err.join()).toContain("cannot reach");
  });
});

test("coordination keeps managed identity and idempotency while sending a reply", async () => {
  const calls: { path: string; agent: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push({
        path: new URL(req.url).pathname,
        agent: req.headers.get("x-aos-agent-id"),
        body: req.method === "GET" ? null : await req.json(),
      });
      return Response.json({ id: "m1", from: "sender", to: "recipient" });
    },
  });
  try {
    const err: string[] = [];
    const code = await run(
      ["message", "reply", "m1", "--text", "Checked", "--request-id", "stable"],
      { AOS_URL: `http://localhost:${server.port}`, AOS_AGENT_ID: "recipient" },
      { out() {}, err: (s) => err.push(s), readFile: () => "" },
    );
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(calls[1]).toEqual({
      path: "/api/coordination/messages",
      agent: "recipient",
      body: { requestId: "stable", to: "sender", text: "Checked", replyTo: "m1" },
    });
  } finally {
    server.stop(true);
  }
});

test("notes search prints one line per note, filtered and capped; read prints the note", async () => {
  const paths: string[] = [];
  const hit = (id: string, source: string, description: string | null) => ({
    id,
    source,
    title: id.split(":")[1],
    description,
    snippet: `the ${String.fromCharCode(2)}rack${String.fromCharCode(3)}\n  plan`,
  });
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      paths.push(url.pathname + url.search);
      if (url.pathname === "/api/memory/doc")
        return Response.json({ doc: { body: "# Plan\nbody" } });
      return Response.json({
        hits: [
          hit("notes:a.md", "notes", "About racks"),
          hit("claude-memory:p/b.md", "claude-memory", null),
          hit("claude-memory:p/c.md", "claude-memory", null),
        ],
      });
    },
  });
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      args,
      { AOS_URL: `http://localhost:${server.port}` },
      { out: (s) => out.push(s), err: (s) => err.push(s), readFile: () => "" },
    );
    return { code, out, err };
  };
  try {
    expect(await cli(["notes", "search", "rack", "plan&co"])).toEqual({
      code: 0,
      out: [
        "notes:a.md\ta.md: About racks",
        "claude-memory:p/b.md\tp/b.md: the rack plan",
        "claude-memory:p/c.md\tp/c.md: the rack plan",
      ],
      err: [],
    });
    expect(paths.at(-1)).toBe("/api/memory/search?q=rack%20plan%26co");
    const some = await cli([
      "notes",
      "search",
      "rack",
      "--source",
      "claude-memory",
      "--limit",
      "1",
    ]);
    expect(some.out).toEqual(["claude-memory:p/b.md\tp/b.md: the rack plan"]);
    expect((await cli(["notes", "read", "notes:a.md"])).out).toEqual(["# Plan\nbody"]);
    expect(paths.at(-1)).toBe("/api/memory/doc?id=notes%3Aa.md");
    expect((await cli(["notes", "search"])).code).toBe(2);
    expect((await cli(["notes", "read", "a", "b"])).code).toBe(2);
  } finally {
    server.stop(true);
  }
});

test("notes search says so on stderr when nothing matches", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ hits: [] }) });
  try {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["notes", "search", "nothing"],
      { AOS_URL: `http://localhost:${server.port}` },
      { out: (s) => out.push(s), err: (s) => err.push(s), readFile: () => "" },
    );
    expect({ code, out, err }).toEqual({ code: 0, out: [], err: ["aos: no notes match"] });
  } finally {
    server.stop(true);
  }
});

test("an error answered with a null body is reported, never a crash", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("null", { status: 502 }) });
  try {
    const err: string[] = [];
    const code = await run(
      ["list"],
      { AOS_URL: `http://localhost:${server.port}` },
      { out() {}, err: (s) => err.push(s), readFile: () => "" },
    );
    expect(code).toBe(1);
    expect(err.join()).toContain("502");
    expect(err.join()).not.toContain("null is not an object");
  } finally {
    server.stop(true);
  }
});

test("mail reads each account by its own id and proposes, never applies", async () => {
  const seen: { method: string; path: string; query: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        body: req.method === "POST" ? await req.json() : undefined,
      });
      if (url.pathname === "/api/mac/outlook/inbox")
        return Response.json({
          total: 9,
          messages: [
            {
              id: "42",
              messageId: "a@x.test",
              from: "Ana",
              subject: "Hola",
              at: "t",
              unread: true,
              flagged: false,
            },
          ],
        });
      if (url.pathname === "/api/google/inbox") return Response.json({ disabled: true });
      if (url.pathname === "/api/mail/personal/outside")
        return Response.json({
          total: 300,
          next: "p2",
          threads: [
            { id: "o1", from: "Banco", subject: "Extracto", at: "t", unread: false, snippet: "x" },
          ],
        });
      if (url.pathname === "/api/mail/work/proposals")
        return Response.json({ proposal: { id: 3, items: [{}, {}] } });
      return Response.json({ folders: [] });
    },
  });
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      args,
      { AOS_URL: `http://localhost:${server.port}` },
      {
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        readFile: () => '{"items":[]}',
      },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  try {
    const inbox = await cli(["mail", "inbox", "work"]);
    expect(JSON.parse(inbox.out)).toEqual({
      total: 9,
      mails: [
        { id: "a@x.test", from: "Ana", subject: "Hola", at: "t", unread: true, flagged: false },
      ],
    });
    // Fresh: the server's kept copy may predate the agent's run.
    expect(seen.at(-1)?.query).toBe("?fresh=1");
    expect((await cli(["mail", "profile", "work"])).code).toBe(0);
    expect(seen.at(-1)?.path).toBe("/api/mac/outlook/folders");
    expect((await cli(["mail", "decisions", "personal"])).code).toBe(0);
    expect(seen.at(-1)?.path).toBe("/api/mail/personal/decisions");
    const outside = await cli(["mail", "outside", "personal", "--page", "p1"]);
    expect(JSON.parse(outside.out)).toEqual({
      total: 300,
      next: "p2",
      mails: [{ id: "o1", from: "Banco", subject: "Extracto", at: "t", unread: false }],
    });
    expect(seen.at(-1)?.query).toBe("?page=p1");
    const off = await cli(["mail", "inbox", "personal"]);
    expect([off.code, off.err]).toEqual([1, "aos: Google is off in Agentic OS"]);
    const proposed = await cli(["mail", "propose", "work", "--input-file", "plan.json"]);
    expect(JSON.parse(proposed.out)).toMatchObject({ proposal: 3, items: 2 });
    expect(seen.at(-1)).toEqual({
      method: "POST",
      path: "/api/mail/work/proposals",
      query: "",
      body: { items: [] },
    });
    expect((await cli(["mail", "propose", "work"])).code).toBe(2);
    expect((await cli(["mail", "inbox", "home"])).code).toBe(2);
    expect(seen.some((s) => s.path.includes("apply"))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("transcript prints the text and proposes, never decides", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        body: req.method === "POST" ? await req.json() : undefined,
      });
      if (req.method === "POST")
        return Response.json({ proposals: { items: [{ kind: "action" }, { kind: "memory" }] } });
      return Response.json({ transcript: { status: "ready", markdown: "[00:00:01] me: hola" } });
    },
  });
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const code = await run(
      args,
      { AOS_URL: `http://localhost:${server.port}` },
      { out: (s) => out.push(s), err: () => {}, readFile: () => '{"summary":"","items":[]}' },
    );
    return { code, out: out.join("\n") };
  };
  try {
    expect(await cli(["transcript", "show", "r 1"])).toEqual({
      code: 0,
      out: "[00:00:01] me: hola",
    });
    expect(seen.at(-1)?.path).toBe("/api/transcripts/r%201");
    const proposed = await cli(["transcript", "propose", "r1", "--input-file", "p.json"]);
    expect(JSON.parse(proposed.out)).toMatchObject({ decisions: 0, actions: 1, memories: 1 });
    expect(seen.at(-1)).toEqual({
      method: "POST",
      path: "/api/transcripts/r1/proposals",
      body: { summary: "", items: [] },
    });
    expect((await cli(["transcript", "propose", "r1"])).code).toBe(2);
    expect((await cli(["transcript", "decide", "r1"])).code).toBe(2);
    expect((await cli(["transcript", "show"])).code).toBe(2);
  } finally {
    server.stop(true);
  }
});
