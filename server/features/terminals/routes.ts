import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { objectiveLabel } from "../../../shared/objectives.ts";
import { TERMINAL_KEYS } from "../../../shared/terminals.ts";
import {
  fillPrompt,
  PROMPT_REFUSAL_TEXT,
  type PromptContext,
  promptRefusal,
  variablesIn,
} from "../../../shared/work-bar.ts";
import { onGithub } from "../../config.ts";
import type { Services } from "../../deps.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { contentVersion } from "../../recovery.ts";
import { traced } from "../../telemetry/span.ts";
import { currentBranch } from "../git/status.ts";
import type { GithubClient } from "../github/prs.ts";
import type { ImageStore } from "../images/store.ts";
import { browseUrl, getComments, getIssue } from "../jira/issues.ts";
import { stripFrontmatter } from "../memory/sources.ts";
import type { MemoryStore } from "../memory/store.ts";
import { workboardActor } from "../workboard/context.ts";
import {
  Auth,
  BringBody,
  ContextQuery,
  CreateBody,
  Inbound,
  type PrRef,
  SendBody,
} from "./bodies.ts";
import {
  type Client,
  MAX_READ_LINES,
  NameBody,
  parseMessage,
  READ_LINES,
  RESTART_REFUSAL_TEXT,
  socketClient,
  type TerminalInfo,
  WaitBody,
} from "./contract.ts";
import { DraftBody } from "./drafts.ts";
import { LaunchError, listLocations } from "./harness.ts";
import { canResume, lostRow } from "./lost.ts";
import { notesContext } from "./notes-prompt.ts";
import { inputRefusal, typedPath } from "./paste-image.ts";
import {
  BRING,
  prContext,
  reviewPrompt,
  type SavedPrompt,
  savedOnlyPrompt,
  ticketContext,
  ticketPrompt,
} from "./ticket-prompt.ts";
import { configOrigins, wsGuard } from "./ws-guard.ts";

export const AUTH_TIMEOUT_MS = 2000;
// Enter goes in its own write: in the same chunk as the text, a TUI may take both as one
// paste and keep the Enter as a newline.
export const ENTER_DELAY_MS = 150;

// Only a document of the saved prompts folder can become a prompt.
async function loadSaved(memory: MemoryStore, id: string): Promise<SavedPrompt> {
  const row = await memory.row(id);
  if (row?.source !== "prompts") throw new LaunchError("not a saved prompt");
  const doc = await memory.get(id);
  return { title: doc.title, body: doc.body };
}

export function terminalRoutes(
  {
    config,
    db,
    terminals,
    tokens,
    jira,
    drafts,
  }: Pick<Services, "config" | "db" | "terminals" | "tokens" | "jira" | "drafts">,
  { memory, github, images }: { memory: MemoryStore; github: GithubClient; images: ImageStore },
) {
  const origins = configOrigins(config);
  const actor = workboardActor(terminals);

  // What a bar prompt's variables read; the branch only when the prompt names it.
  const promptContext = async (t: TerminalInfo, body: string): Promise<PromptContext> => ({
    ticket: t.ticket,
    objective: t.objective ? objectiveLabel(t.objective) : null,
    cwd: t.cwd,
    location: t.location,
    branch: variablesIn(body).includes("branch")
      ? await currentBranch({ bin: config.git.bin ?? "", cwd: t.cwd, env: await terminals.env })
      : null,
  });

  // A PR read from GitHub, for a repo this profile reads there; a closed one is refused.
  async function openPull(ref: z.infer<typeof PrRef>) {
    const repo = config.repos.find((r) => r.id === ref.repo);
    if (!repo) throw new LaunchError(`unknown repo: ${ref.repo}`);
    if (!config.providers.github || !onGithub(repo))
      throw new LaunchError(`${repo.id} is not read from GitHub in this profile`);
    const pr = await github.pull(repo, ref.number);
    if (!pr.open) throw new LaunchError(`PR #${ref.number} is no longer open`);
    return { repo, pr };
  }

  // What an agent gets: the ticket or the PR with its whole discussion, read together.
  const ticketData = (key: string) =>
    Promise.all([getIssue(jira, config, key), getComments(jira, key)]);
  async function ticketText(key: string, saved?: SavedPrompt) {
    const [issue, comments] = await ticketData(key);
    return ticketPrompt(issue, comments, saved);
  }
  // An item's content and its discussion, with no instruction: what an agent gets from
  // "Llevar a…" and what «Copiar contexto» copies.
  async function ticketContextText(key: string) {
    const [issue, comments] = await ticketData(key);
    return ticketContext(issue, comments);
  }
  async function prContextText({ repo, pr }: Awaited<ReturnType<typeof openPull>>) {
    const { comments, truncated } = await github.discussion(repo, pr.number);
    return prContext(repo, pr, comments, truncated);
  }
  async function reviewText(
    { repo, pr }: Awaited<ReturnType<typeof openPull>>,
    saved?: SavedPrompt,
  ) {
    const discussion = await github.discussion(repo, pr.number);
    return reviewPrompt(repo, pr, discussion.comments, saved, discussion.truncated);
  }

  return (
    new Hono()
      .get("/", async (c) =>
        c.json({
          terminals: await terminals.list(),
          locations: listLocations(config),
          // Whether "Abrir carpeta" can run: the profile names an editor.
          openFolder: Boolean(config.terminals.editor),
        }),
      )
      // «Copiar contexto»: the text "Llevar a…" gives an agent, for the user to paste anywhere.
      .get("/context", async (c) => {
        const query = ContextQuery.safeParse(c.req.query());
        if (!query.success)
          return c.json({ error: "bad_request", detail: query.error.issues }, 400);
        if ("ticket" in query.data) {
          if (!config.jira) return c.json({ error: "jira_not_configured" }, 400);
          return c.json({ text: await ticketContextText(query.data.ticket) });
        }
        return c.json({ text: await prContextText(await openPull(query.data)) });
      })
      .get("/launches/:requestId", async (c) => {
        const id = z.string().uuid().safeParse(c.req.param("requestId"));
        if (!id.success) return c.json({ error: "bad_request" }, 400);
        return c.json((await terminals.launchStatus?.(id.data)) ?? null);
      })
      .post("/", async (c) => {
        const body = CreateBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const { ticket, review, savedPrompt, harness, model, effort } = body.data;
        if (body.data.prompt !== undefined && (ticket || review || savedPrompt))
          return c.json({ error: "bad_request", detail: "one prompt source only" }, 400);
        if (harness === "shell" && (review || savedPrompt))
          return c.json({ error: "bad_request", detail: "a shell takes no prompt" }, 400);
        if (ticket && review)
          return c.json({ error: "bad_request", detail: "a ticket or a PR, not both" }, 400);
        // The prompt is built here from Jira, GitHub and the prompts folder, never taken from
        // the browser. A shell gets none.
        if (ticket && harness !== "shell" && !config.jira)
          return c.json({ error: "jira_not_configured" }, 400);
        const requestFingerprint = contentVersion(JSON.stringify(body.data));
        if (body.data.requestId && terminals.launchStatus) {
          const previous = await terminals.launchStatus(body.data.requestId);
          if (previous) {
            if (previous.fingerprint !== requestFingerprint)
              return c.json({ error: "request_conflict" }, 409);
            if (previous.terminal) return c.json({ terminal: previous.terminal }, 200);
            if (previous.state === "rejected")
              return c.json({ error: "launch_rejected", detail: previous.error ?? "" }, 400);
            return c.json(
              {
                error: "launch_uncertain",
                detail: "Comprueba las terminales antes de iniciar otra petición.",
                requestId: body.data.requestId,
              },
              409,
            );
          }
        }
        const saved = savedPrompt ? await loadSaved(memory, savedPrompt) : undefined;
        let location = body.data.location;
        let label = ticket;
        let prompt = body.data.prompt;
        if (review) {
          const pull = await openPull(review);
          // A review reads the PR through gh from the repo's own checkout and changes nothing.
          location = `repo:${pull.repo.id}`;
          label = `${pull.repo.id}#${review.number}`;
          prompt = await reviewText(pull, saved);
        } else if (ticket && harness !== "shell") {
          prompt = await ticketText(ticket, saved);
        } else if (saved) {
          prompt = savedOnlyPrompt(saved);
        }
        const { cols, rows } = body.data;
        const spec = {
          requestId: body.data.requestId,
          requestFingerprint,
          harness,
          location,
          ticket: label,
          prompt,
          model,
          effort,
          cols,
          rows,
        };
        return c.json({ terminal: await terminals.create(spec) }, 201);
      })
      .post("/:id/attach", async (c) => {
        const id = c.req.param("id");
        if (!(await terminals.get(id))) {
          // Lost when the PTY host restarted, and «Reanudar» can bring it back.
          const lost = lostRow(db, id);
          return c.json({ error: lost && canResume(lost) ? "lost" : "not_found" }, 404);
        }
        // localGuard already proved this Origin is one of ours.
        return c.json({ token: tokens.issue(id, c.req.header("origin") ?? "") });
      })
      // Agent access (`aos`): read, type and wait without attaching, so the window stays.
      .get("/:id/text", async (c) => {
        const lines = Number(c.req.query("lines") ?? READ_LINES);
        if (!Number.isInteger(lines) || lines < 1 || lines > MAX_READ_LINES)
          return c.json({ error: "bad_request", detail: `lines: 1 to ${MAX_READ_LINES}` }, 400);
        const text = await terminals.read(c.req.param("id"), lines);
        return text ? c.json(text) : c.json({ error: "not_found" }, 404);
      })
      .post("/:id/send", async (c) => {
        const body = SendBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const id = c.req.param("id");
        // `seq` from before the write: a wait `after` it sees the echo and the answer.
        const before = await terminals.read(id, 1);
        if (!before) return c.json({ error: "not_found" }, 404);
        if (before.state !== "running") return c.json({ error: "not_running" }, 409);
        const { text, keys, enter, interrupt } = body.data;
        // Who typed what stays out of the log; that something was typed does not.
        log("terminals").info(
          `send ${id}: ${text ? Buffer.byteLength(text) : 0} bytes${keys ? `, ${keys.length} keys` : ""}${enter ? ", enter" : ""}${interrupt ? ", interrupt" : ""}`,
        );
        let sent = true;
        if (interrupt) sent &&= await terminals.write(id, "\x03");
        if (text) sent &&= await terminals.write(id, text, { paste: true });
        for (const key of keys ?? []) sent &&= await terminals.write(id, TERMINAL_KEYS[key]);
        if (enter) {
          if (text) await Bun.sleep(ENTER_DELAY_MS);
          sent &&= await terminals.write(id, "\r");
        }
        return sent ? c.json({ sent, seq: before.seq }) : c.json({ error: "not_running" }, 409);
      })
      // A ticket or a PR typed into a running terminal, never followed by Enter: the user
      // reads it and sends it. An agent gets its whole content, with no instruction unless a
      // task is asked (then the prompt a launch would give); a shell gets one line (the key or
      // ref and its link), so nothing runs. A multi-line prompt goes only as a
      // paste: typed bare, each line would be a separate message. A work bar prompt is the
      // one sent with Enter, so only an agent waiting for its next message takes it.
      .post("/:id/bring", async (c) => {
        const body = BringBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const id = c.req.param("id");
        const t = await terminals.get(id);
        if (!t) return c.json({ error: "not_found" }, 404);
        const refused = inputRefusal(t);
        if (refused) return c.json(refused, 409);
        const agent = t.harness !== "shell";
        let text: string;
        let enter = false;
        if ("prompt" in body.data) {
          const refusal = promptRefusal(t);
          if (refusal) return c.json({ error: refusal, detail: PROMPT_REFUSAL_TEXT[refusal] }, 409);
          const saved = stripFrontmatter((await loadSaved(memory, body.data.prompt)).body).trim();
          const filled = fillPrompt(saved, await promptContext(t, saved));
          if ("missing" in filled)
            return c.json(
              { error: "missing", detail: filled.missing.map((v) => `{{${v}}}`).join(", ") },
              409,
            );
          text = BRING.check(filled.text);
          enter = true;
        } else if ("images" in body.data) {
          // Several paths on one line, as a Finder drag of several files types them.
          const paths = await images.forTerminal(body.data.images);
          text = paths.map((p) => typedPath(p)).join(" ");
        } else if ("notes" in body.data) {
          // Notes are instructions for an agent; typed into a shell they would run as commands.
          if (!agent)
            return c.json({ error: "not_an_agent", detail: "diff notes go to an agent" }, 409);
          text = notesContext(t.location, body.data.notes);
        } else if ("ticket" in body.data) {
          const { ticket, task } = body.data;
          if (agent && !config.jira) return c.json({ error: "jira_not_configured" }, 400);
          if (agent && task) {
            const [issue, comments] = await ticketData(ticket);
            const intent = task === "review" ? "review" : undefined;
            text = ticketPrompt(issue, comments, undefined, intent, BRING);
          } else if (agent) text = await ticketContextText(ticket);
          else text = config.jira ? `${ticket} ${browseUrl(config.jira, ticket)}` : ticket;
        } else {
          const pull = await openPull(body.data.pr);
          const { repo, pr } = pull;
          if (agent && body.data.task) {
            const { comments, truncated } = await github.discussion(repo, pr.number);
            text = reviewPrompt(repo, pr, comments, undefined, truncated, BRING);
          } else if (agent) text = await prContextText(pull);
          else text = `${repo.owner}/${repo.name}#${pr.number} ${pr.url}`;
        }
        let sent = await terminals.write(id, text, {
          paste: text.includes("\n") ? "only" : true,
        });
        if (sent && enter) {
          await Bun.sleep(ENTER_DELAY_MS);
          sent = await terminals.write(id, "\r");
        }
        log("terminals").info(
          `bring ${id}: ${Buffer.byteLength(text)} bytes${enter ? ", enter" : ""}${sent ? "" : ", refused"}`,
        );
        return sent
          ? c.json({ sent, bytes: Buffer.byteLength(text) })
          : c.json({ error: "no_paste", detail: "the program is not taking pasted text" }, 409);
      })
      .post("/:id/wait", async (c) => {
        const body = WaitBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        // A long poll: its time is a known wait, not a gap nobody instrumented.
        const result = await traced("terminal wait", "wait", {}, () =>
          terminals.waitFor(c.req.param("id"), body.data),
        );
        return result ? c.json(result) : c.json({ error: "not_found" }, 404);
      })
      .post("/:id/name", async (c) => {
        const body = NameBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const id = c.req.param("id");
        if (!(await terminals.rename(id, body.data.name)))
          return c.json({ error: "not_found" }, 404);
        return c.json({ name: body.data.name });
      })
      // The terminal's folder in the user's editor: the path comes from the terminal the
      // server knows, never from the request, and the argv is fixed.
      .post("/:id/open-folder", async (c) => {
        const t = await terminals.get(c.req.param("id"));
        if (!t) return c.json({ error: "not_found" }, 404);
        const editor = config.terminals.editor;
        if (!editor) return c.json({ error: "editor_not_configured" }, 409);
        if (!isAbsolute(t.cwd) || !existsSync(t.cwd)) return c.json({ error: "folder_gone" }, 409);
        const proc = Bun.spawn([editor, t.cwd], {
          env: await terminals.env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        });
        proc.unref();
        return c.json({ opened: true });
      })
      // The images in the draft of the Claude session running in this terminal, from its hud
      // mod: only that terminal's own session may set them.
      .post("/:id/drafts", async (c) => {
        const id = c.req.param("id");
        const owner = await actor(c.req.header("x-aos-agent-id")).catch(() => null);
        if (owner !== id) return c.json({ error: "unknown_actor" }, 403);
        const body = DraftBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        try {
          drafts.set(id, body.data);
        } catch (err) {
          return c.json({ error: "bad_request", detail: errorMessage(err) }, 400);
        }
        return c.json({ images: body.data.images.length });
      })
      // One draft image's bytes, with the image history's headers: only this origin may embed
      // them, and nothing keeps them.
      .get("/:id/drafts/:n", (c) => {
        const image = drafts.get(c.req.param("id"), Number(c.req.param("n")));
        if (!image) return c.json({ error: "not_found" }, 404);
        return c.body(image.bytes, 200, {
          "Content-Type": image.mime,
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": "no-store",
        });
      })
      .post("/:id/stop", async (c) => {
        const id = c.req.param("id");
        if (!(await terminals.get(id))) return c.json({ error: "not_found" }, 404);
        return c.json({ stopping: await terminals.stop(id) });
      })
      .post("/:id/resume", async (c) => {
        const terminal = await terminals.resume(c.req.param("id"));
        return terminal ? c.json({ terminal }) : c.json({ error: "not_found" }, 404);
      })
      .post("/:id/restart", async (c) => {
        const result = await terminals.restart(c.req.param("id"));
        if (!result) return c.json({ error: "not_found" }, 404);
        if ("refused" in result)
          return c.json(
            { error: result.refused, detail: RESTART_REFUSAL_TEXT[result.refused] },
            409,
          );
        return c.json(result);
      })
      .delete("/:id", async (c) => {
        const id = c.req.param("id");
        if (!(await terminals.get(id))) return c.json({ error: "not_found" }, 404);
        drafts.clear(id);
        return c.json({ removed: await terminals.remove(id) });
      })
      .get(
        "/:id/ws",
        wsGuard(origins),
        upgradeWebSocket((c) => {
          const id = c.req.param("id") ?? "";
          const origin = c.req.header("origin") ?? "";
          let client: Client | undefined;
          let timer: Timer | undefined;
          return {
            onOpen(_event, ws) {
              timer = setTimeout(() => {
                if (!client) ws.close(4401, "auth timeout");
              }, AUTH_TIMEOUT_MS);
            },
            onMessage(event, ws) {
              if (!client) {
                // Unauthenticated: the only thing this socket can do is present its token.
                const auth = parseMessage(Auth, event.data);
                if (!auth || !tokens.consume(auth.token, id, origin)) {
                  ws.close(4401, "unauthorized");
                  return;
                }
                clearTimeout(timer);
                client = socketClient(ws.raw as ServerWebSocket);
                // 4503: the PTY host is unreachable; the window retries.
                const attached = client;
                Promise.resolve(terminals.attach(id, attached, auth.take)).then(
                  (ok) => (ok ? drafts.join(id, attached) : ws.close(4404, "not found")),
                  () => ws.close(4503, "pty host unavailable"),
                );
                return;
              }
              const msg = parseMessage(Inbound, event.data);
              if (!msg) return;
              if (msg.type === "ping") client.send(JSON.stringify({ type: "pong" }));
              else if (msg.type === "input") terminals.input(id, client, msg.data);
              else terminals.resize(id, client, msg.cols, msg.rows);
            },
            onClose() {
              clearTimeout(timer);
              if (client) {
                terminals.detach(id, client);
                drafts.leave(id, client);
              }
            },
          };
        }),
      )
  );
}
