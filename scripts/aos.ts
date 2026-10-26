// aos: drives Agentic OS terminals and searches its notes from a script or an agent, over the
// app's own API.
// JSON on stdout, errors on stderr. Exit codes: 0 ok, 1 error, 2 usage, 3 the wait ended
// without its condition (time ran out, or the terminal exited before the --until text).
// Build: bun build --compile scripts/aos.ts --outfile bin/aos
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MAX_READ_LINES, MAX_WAIT_MS } from "../server/features/terminals/contract.ts";
import { machinePath, PROXY_WRITE_MS } from "../shared/machines.ts";

const USAGE = `usage:
  aos list
  aos create --harness <id> --location <id> [--prompt-file <file|->] [--model <id>] [--effort <e>]
  aos read <id> [--lines <n>] [--plain]
  aos send <id> [--text <text> | --text-file <file|->] [--enter] [--interrupt]
  aos wait <id> [--after <seq>] [--quiet-ms <n>] [--timeout-ms <n>] [--until <text>]
  aos stop <id>
  aos rm <id>
  aos capabilities | self | coordination
  aos context [--input-file <json|->]
  aos message list | get <id> | send <recipient> | reply <id> [--text <text> | --text-file <file|->] [--request-id <id>]
  aos reserve --location <id> --path <relative-file> [--path <file>] --reason <text>
  aos reservations | release <id>
  aos consult list | get <id> | prepare --input-file <json|-> | cancel <id>
  aos consult followup <id> --input-file <json|->
  aos events --after <revision> [--timeout-ms <n>]
  aos notes search <words> [--limit <n>] [--source <id>] | read <id>
  aos mail profile | inbox | decisions <work|personal>
  aos mail outside personal [--page <token>]
  aos mail propose <work|personal> --input-file <json|->
  aos transcript show <id> | propose <id> --input-file <json|->
  aos trace health [--since 24h] [--vs 7d] | errors [--since 1h] | <trace-or-request-id>
  aos trace slow [--since 1h] [--by total] | since <cursor> | status | full [<min> | off]
                                                                       [--flush] [--json]
Consultation JSON: {requestId,location,prompt,participants:[{harness,model,effort?}],timeoutMs?}.
Notes search prints one line per note (id, title, what it is about); read prints the note.
Prepare freezes the batch; the user approves it in Agentes → Consultas. No automatic retries.
Mail: work is Outlook, personal is Gmail. profile prints where the user files mail; inbox prints
the inbox with each mail's id; decisions prints what the user kept and unticked before;
outside prints 100 mails out of the inbox under no label, and the token of the next page.
Proposal JSON: {items:[{id,op:"move"|"trash"|"archive",folder?,newFolder?,reason}]};
archive and newFolder are Gmail only.
The server checks it and keeps it for the user, who reviews and applies it in Inicio.
Transcript: show prints a recording's text, one line per utterance; propose sends
{summary,items:[{kind:"decision"|"action"|"memory",text,owner?,dueOn?,at?}]} for the user to
accept or discard in the recording's tile.
Trace reads the server's traces from data/telemetry.db (AGENTIC_OS_DATA sets the folder), also
while the server is down: health is the place to start (new errors, regressions against the
baseline, heaviest calls, waits with no span, event loop, space); errors groups failures by
route and cause; slow gives p50/p95 per route and per outside call (--by total: where the time
goes); an id prints the waterfall with each span's own time, its logs and its uncovered gaps.
AOS_AGENT_ID identifies the managed session; --agent <id> supports older sessions.
AOS_URL sets the server (default http://localhost:4317).
--machine <id> (or AOS_MACHINE) runs list, create, read, send, wait, stop and rm on another
machine of the hub's config, through the hub.`;

const OPTIONS = {
  agent: { type: "string" },
  machine: { type: "string" },
  "request-id": { type: "string" },
  "input-file": { type: "string" },
  path: { type: "string", multiple: true },
  reason: { type: "string" },
  harness: { type: "string" },
  location: { type: "string" },
  "prompt-file": { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  lines: { type: "string" },
  limit: { type: "string" },
  page: { type: "string" },
  source: { type: "string" },
  plain: { type: "boolean" },
  text: { type: "string" },
  "text-file": { type: "string" },
  enter: { type: "boolean" },
  interrupt: { type: "boolean" },
  after: { type: "string" },
  "quiet-ms": { type: "string" },
  "timeout-ms": { type: "string" },
  until: { type: "string" },
  since: { type: "string" },
  vs: { type: "string" },
  by: { type: "string" },
  json: { type: "boolean" },
  flush: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export const DEFAULT_WAIT_MS = 30_000;
const NOTES_LIMIT = 5;
// The search's snippet marks (control characters 2 and 3).
const MARKS = new RegExp(`[${String.fromCharCode(2, 3)}]`, "g");
type NoteHit = {
  id: string;
  source: string;
  title: string;
  description: string | null;
  snippet: string;
};

export type Io = {
  out: (s: string) => void;
  err: (s: string) => void;
  readFile: (path: string) => string;
};

const nodeIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  readFile: (path) => readFileSync(path === "-" ? 0 : path, "utf8"),
};

class Usage extends Error {}
class Failed extends Error {}

export async function run(argv: string[], env: Record<string, string | undefined>, io = nodeIo) {
  try {
    return await dispatch(argv, env.AOS_URL ?? "http://localhost:4317", io, env);
  } catch (err) {
    if (err instanceof Usage) {
      io.err(`aos: ${err.message}\n${USAGE}`);
      return 2;
    }
    io.err(`aos: ${(err as Error).message}`);
    return 1;
  }
}

// What another machine runs through the hub's door; coordination and notes stay on this one,
// where the agent's own identity is.
const ON_MACHINE = new Set(["list", "create", "read", "send", "wait", "stop", "rm"]);

async function dispatch(
  argv: string[],
  base: string,
  io: Io,
  env: Record<string, string | undefined>,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new Usage((err as Error).message);
  }
  const { values: v, positionals } = parsed;
  const [command, id, ...extra] = positionals;
  if (v.help || command === "help" || !command) {
    io.out(USAGE);
    return v.help || command === "help" ? 0 : 2;
  }
  const machine = v.machine ?? env.AOS_MACHINE ?? "";
  if (machine && !ON_MACHINE.has(command))
    throw new Usage(`--machine works with ${[...ON_MACHINE].join(", ")}`);
  const api = client(base, v.agent ?? env.AOS_AGENT_ID, machine);
  const print = (data: unknown) => io.out(JSON.stringify(data, null, 2));
  const needId = () => {
    if (!id || extra.length) throw new Usage(`${command} takes one terminal id`);
    return encodeURIComponent(id);
  };

  switch (command) {
    case "capabilities":
    case "self":
    case "coordination":
      print(
        await api("GET", `/api/coordination${command === "coordination" ? "" : `/${command}`}`),
      );
      return 0;
    case "context":
      print(
        await api(
          "POST",
          "/api/coordination/context",
          v["input-file"] ? JSON.parse(io.readFile(v["input-file"])) : {},
        ),
      );
      return 0;
    case "reservations":
      print(((await api("GET", "/api/coordination")) as { reservations: unknown }).reservations);
      return 0;
    case "reserve":
      if (!v.location || !v.path?.length || !v.reason)
        throw new Usage("reserve needs --location, --path and --reason");
      print(
        await api("POST", "/api/coordination/reservations", {
          location: v.location,
          paths: v.path,
          reason: v.reason,
        }),
      );
      return 0;
    case "release":
      print(await api("DELETE", `/api/coordination/reservations/${needId()}`, {}));
      return 0;
    case "events": {
      if (v.after === undefined) throw new Usage("events needs --after");
      const timeoutMs =
        v["timeout-ms"] === undefined
          ? 30_000
          : Math.min(int(v["timeout-ms"], "--timeout-ms"), MAX_WAIT_MS);
      print(
        await api(
          "POST",
          "/api/coordination/wait",
          { after: int(v.after, "--after"), timeoutMs },
          timeoutMs,
        ),
      );
      return 0;
    }
    case "message":
    case "consult": {
      const resource = command === "message" ? "messages" : "consultations";
      const target = extra[0];
      const path = `/api/coordination/${resource}`;
      if (id === "list") {
        print(((await api("GET", "/api/coordination")) as Record<string, unknown>)[resource]);
        return 0;
      }
      if (id === "get" && target) {
        print(await api("GET", `${path}/${encodeURIComponent(target)}`));
        return 0;
      }
      if (command === "message" && (id === "send" || id === "reply") && target) {
        if (v.text !== undefined && v["text-file"] !== undefined)
          throw new Usage("--text or --text-file, not both");
        const text = v["text-file"] === undefined ? v.text : io.readFile(v["text-file"]);
        if (!text) throw new Usage("message needs --text or --text-file");
        const parent =
          id === "reply"
            ? ((await api("GET", `${path}/${encodeURIComponent(target)}`)) as { from: string })
            : null;
        print(
          await api("POST", path, {
            requestId: v["request-id"] ?? crypto.randomUUID(),
            to: parent?.from ?? target,
            text,
            ...(parent && { replyTo: target }),
          }),
        );
        return 0;
      }
      if (command === "consult" && id === "prepare" && v["input-file"]) {
        print(await api("POST", path, JSON.parse(io.readFile(v["input-file"])), 100_000));
        return 0;
      }
      if (command === "consult" && id === "cancel" && target) {
        print(await api("POST", `${path}/${encodeURIComponent(target)}/cancel`, {}));
        return 0;
      }
      if (command === "consult" && id === "followup" && target && v["input-file"]) {
        print(
          await api(
            "POST",
            `${path}/${encodeURIComponent(target)}/followup`,
            JSON.parse(io.readFile(v["input-file"])),
          ),
        );
        return 0;
      }
      throw new Usage(`invalid ${command} command; see aos help`);
    }
    case "notes": {
      // Notes and memories of every project: search first, then read the ones that fit.
      const arg = extra.join(" ");
      if (id === "search" && arg) {
        const limit = v.limit === undefined ? NOTES_LIMIT : int(v.limit, "--limit");
        const { hits } = (await api("GET", `/api/memory/search?q=${encodeURIComponent(arg)}`)) as {
          hits: NoteHit[];
        };
        const shown = hits.filter((h) => !v.source || h.source === v.source).slice(0, limit);
        if (!shown.length) io.err("aos: no notes match");
        for (const h of shown) {
          const about = (h.description ?? h.snippet).replace(MARKS, "").replace(/\s+/g, " ").trim();
          io.out(`${h.id}\t${h.title}: ${about}`);
        }
        return 0;
      }
      if (id === "read" && extra.length === 1) {
        const path = `/api/memory/doc?id=${encodeURIComponent(arg)}`;
        io.out(((await api("GET", path)) as { doc: { body: string } }).doc.body);
        return 0;
      }
      throw new Usage("notes search <words> or notes read <id>");
    }
    case "mail": {
      // The mail categorizer: read where the user files mail and what the inbox holds, then
      // propose. Nothing here changes mail: only the user applies, from Inicio.
      const account = extra[0];
      if (extra.length !== 1 || (account !== "work" && account !== "personal"))
        throw new Usage("mail profile|inbox|outside|decisions|propose <work|personal>");
      const work = account === "work";
      // A cold read of every Outlook folder, or the Gmail profile within its quota, takes minutes.
      // The inbox is read fresh: the server's kept copy may be from before Inicio was closed,
      // and the proposal is checked against the copy this read leaves.
      const read = async (path: string) => {
        const data = (await api("GET", path, undefined, 150_000)) as { disabled?: boolean };
        if (data.disabled) throw new Failed(`${work ? "Outlook" : "Google"} is off in Agentic OS`);
        return data;
      };
      if (id === "profile") {
        print(await read(work ? "/api/mac/outlook/folders" : "/api/google/cleanup/profile"));
        return 0;
      }
      if (id === "outside") {
        const query = v.page ? `?${new URLSearchParams({ page: v.page })}` : "";
        const { threads, next, total } = (await read(`/api/mail/${account}/outside${query}`)) as {
          threads: {
            id: string;
            from: string;
            subject: string | null;
            at: string;
            unread: boolean;
          }[];
          next: string | null;
          total: number;
        };
        print({
          total,
          next,
          mails: threads.map(({ id, from, subject, at, unread }) => ({
            id,
            from,
            subject,
            at,
            unread,
          })),
        });
        return 0;
      }
      if (id === "decisions") {
        print(await api("GET", `/api/mail/${account}/decisions`));
        return 0;
      }
      if (id === "inbox" && work) {
        const { total, messages } = (await read("/api/mac/outlook/inbox?fresh=1")) as {
          total: number;
          messages: {
            messageId: string;
            from: string;
            subject: string | null;
            at: string;
            unread: boolean;
            flagged: boolean;
          }[];
        };
        print({
          total,
          mails: messages.map(({ messageId, from, subject, at, unread, flagged }) => ({
            id: messageId,
            from,
            subject,
            at,
            unread,
            flagged,
          })),
        });
        return 0;
      }
      if (id === "inbox") {
        const { total, threads } = (await read("/api/google/inbox?fresh=1")) as {
          total: number;
          threads: {
            id: string;
            from: string;
            subject: string | null;
            at: string;
            unread: boolean;
            starred: boolean;
            snippet: string;
          }[];
        };
        print({
          total,
          mails: threads.map(({ id, from, subject, at, unread, starred, snippet }) => ({
            id,
            from,
            subject,
            at,
            unread,
            starred,
            snippet,
          })),
        });
        return 0;
      }
      if (id === "propose") {
        if (!v["input-file"]) throw new Usage("mail propose needs --input-file");
        const { proposal } = (await api(
          "POST",
          `/api/mail/${account}/proposals`,
          JSON.parse(io.readFile(v["input-file"])),
          90_000,
        )) as { proposal: { id: number; items: unknown[] } };
        print({
          proposal: proposal.id,
          items: proposal.items.length,
          next: "The user reviews and applies it in Inicio; nothing has moved.",
        });
        return 0;
      }
      throw new Usage("mail profile|inbox|outside|decisions|propose <work|personal>");
    }
    case "transcript": {
      // A meeting's review: read the text, then propose. The user decides each item in the tile.
      if (!id || extra.length !== 1) throw new Usage("transcript show|propose <id>");
      const path = `/api/transcripts/${encodeURIComponent(extra[0] as string)}`;
      if (id === "show") {
        const { transcript } = (await api("GET", path)) as {
          transcript: { status: string; markdown: string };
        };
        if (transcript.status !== "ready") io.err(`aos: the transcript is ${transcript.status}`);
        io.out(transcript.markdown);
        return 0;
      }
      if (id === "propose") {
        if (!v["input-file"]) throw new Usage("transcript propose needs --input-file");
        const { proposals } = (await api(
          "POST",
          `${path}/proposals`,
          JSON.parse(io.readFile(v["input-file"])),
        )) as { proposals: { items: { kind: string }[] } };
        const count = (kind: string) => proposals.items.filter((i) => i.kind === kind).length;
        print({
          decisions: count("decision"),
          actions: count("action"),
          memories: count("memory"),
          next: "The user accepts or discards each item in the meeting's tile; nothing is saved yet.",
        });
        return 0;
      }
      throw new Usage("transcript show|propose <id>");
    }
    case "list":
      if (id) throw new Usage("list takes no arguments");
      print(((await api("GET", "/api/terminals")) as { terminals: unknown }).terminals);
      return 0;
    case "create": {
      if (id) throw new Usage("create takes no positional arguments");
      if (!v.harness || !v.location) throw new Usage("create needs --harness and --location");
      const body = {
        requestId: v["request-id"] ?? crypto.randomUUID(),
        harness: v.harness,
        location: v.location,
        prompt: v["prompt-file"] === undefined ? undefined : io.readFile(v["prompt-file"]),
        model: v.model,
        effort: v.effort,
      };
      print(((await api("POST", "/api/terminals", body)) as { terminal: unknown }).terminal);
      return 0;
    }
    case "read": {
      const path = `/api/terminals/${needId()}/text`;
      const lines = v.lines === undefined ? "" : `?lines=${int(v.lines, "--lines")}`;
      const screen = (await api("GET", path + lines)) as { text: string };
      if (v.plain) io.out(screen.text);
      else print(screen);
      return 0;
    }
    case "send": {
      const path = `/api/terminals/${needId()}/send`;
      if (v.text !== undefined && v["text-file"] !== undefined)
        throw new Usage("--text or --text-file, not both");
      const text = v["text-file"] === undefined ? v.text : io.readFile(v["text-file"]);
      print(await api("POST", path, { text, enter: v.enter, interrupt: v.interrupt }));
      return 0;
    }
    case "wait": {
      const terminal = needId();
      let after = v.after === undefined ? undefined : int(v.after, "--after");
      const quietMs = v["quiet-ms"] === undefined ? undefined : int(v["quiet-ms"], "--quiet-ms");
      const total =
        v["timeout-ms"] === undefined ? DEFAULT_WAIT_MS : int(v["timeout-ms"], "--timeout-ms");
      let left = total;
      // The server holds one wait for MAX_WAIT_MS at most, and the hub relays a worker's for
      // less; a longer one is several in a row.
      const slice = machine ? Math.min(MAX_WAIT_MS, PROXY_WRITE_MS - 10_000) : MAX_WAIT_MS;
      // Quiet output is not a finished command: with --until, waiting goes on until the text
      // is on the screen, the terminal exits or the time runs out.
      for (;;) {
        const timeoutMs = Math.min(left, slice);
        const started = Date.now();
        const result = (await api(
          "POST",
          `/api/terminals/${terminal}/wait`,
          { after, quietMs, timeoutMs },
          timeoutMs,
        )) as { reason: string; seq: number };
        // A timed-out wait used its whole slice; a quiet one only what it took.
        left -= result.reason === "timeout" ? timeoutMs : Date.now() - started;
        let found: boolean | undefined;
        if (v.until !== undefined) {
          const path = `/api/terminals/${terminal}/text?lines=${MAX_READ_LINES}`;
          found = ((await api("GET", path)) as { text: string }).text.includes(v.until);
        }
        const done = found ?? result.reason !== "timeout";
        if (done || result.reason === "exit" || left <= 0) {
          print(found === undefined ? result : { ...result, found });
          return done ? 0 : 3;
        }
        // Quiet but not there yet: the next wait needs output newer than this.
        if (result.reason === "idle") after = result.seq;
      }
    }
    case "stop":
      print(await api("POST", `/api/terminals/${needId()}/stop`, {}));
      return 0;
    case "rm":
      print(await api("DELETE", `/api/terminals/${needId()}`, {}));
      return 0;
    case "trace": {
      if (
        !id ||
        extra.length > (id === "since" || id === "full" ? 1 : 0) ||
        (id === "since" && !extra[0])
      )
        throw new Usage("trace takes health, errors, slow, since <cursor>, status, full or an id");
      // Loaded here: the other commands never pay for the trace reader.
      const { trace } = await import("./aos-trace.ts");
      try {
        return await trace(
          {
            sub: id,
            arg: extra[0],
            since: v.since,
            vs: v.vs,
            by: v.by,
            json: v.json,
            flush: v.flush,
          },
          api,
          io.out,
        );
      } catch (err) {
        throw new Failed((err as Error).message);
      }
    }
    default:
      throw new Usage(`unknown command: ${command}`);
  }
}

function int(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Usage(`${flag} must be a whole number`);
  return n;
}

// The app's guard wants its own Origin and a JSON body type on every write.
function client(base: string, agent: string | undefined, machine: string) {
  const origin = new URL(base).origin;
  return async (method: string, path: string, body?: unknown, waitMs = 0) => {
    let res: Response;
    try {
      res = await fetch(`${origin}${machinePath(path, machine)}`, {
        method,
        headers: {
          ...(agent && { "x-aos-agent-id": agent }),
          ...(body === undefined ? {} : { origin, "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(waitMs + 30_000),
      });
    } catch (err) {
      throw new Failed(`cannot reach ${origin}: ${(err as Error).message}`);
    }
    // A body that is JSON `null` (a worker mid-restart) reads like no body at all.
    const data = ((await res.json().catch(() => null)) ?? {}) as {
      error?: string;
      detail?: unknown;
    };
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      throw new Failed(
        `${res.status} ${data.error ?? res.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }
    return data;
  };
}

if (import.meta.main) process.exit(await run(process.argv.slice(2), process.env));
