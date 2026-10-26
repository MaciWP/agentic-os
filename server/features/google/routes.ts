import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cached, cachedBy } from "../../cache.ts";
import type { Deps } from "../../deps.ts";
import { fileCopy } from "../../json-file.ts";
import { consumeState, createState, oauthPage, pkce, saveConnection } from "../../oauth.ts";
import { ProviderError } from "../../provider-error.ts";
import { fetchProfile, GmailCopy, googleClient, parseDay, THREAD_ID } from "./client.ts";
import { authorizeUrl, exchangeCode, READ_SCOPES } from "./oauth.ts";

const COOKIE = "aos_google_state";
const TTL_MS = 60_000;

// The Gmail reads the routes and the mail categorizer share: one client, so one quota bucket.
// Today's agenda and the inbox answer at once and say through `onChange` when they changed.
// With `copyPath`, the inbox is kept on disk too, so a restarted server answers it at once.
export function googleReads(db: Database, onChange?: () => void, copyPath?: string) {
  const client = googleClient(db, { copy: copyPath ? fileCopy(copyPath, GmailCopy) : null });
  return {
    client,
    agenda: cached(() => client.agenda(), { ttlMs: TTL_MS, onChange }),
    // Another day's agenda: one read per day per minute, however fast the days are paged.
    agendaOn: cachedBy<Awaited<ReturnType<typeof client.agenda>>>({ ttlMs: TTL_MS }),
    inbox: cached(() => client.inbox(), { ttlMs: TTL_MS, onChange, initial: client.storedInbox() }),
    // ~1,500 Gmail reads: kept for a while, asked again only on demand.
    profile: cached(() => client.profile(), { ttlMs: 30 * 60_000 }),
  };
}
export type GoogleReads = ReturnType<typeof googleReads>;

// Google's Desktop client returns the login to a loopback address, so the login starts and ends
// on http://localhost:<port>: the state cookie must live on the host the callback reaches.
export function googleRoutes({ config, db }: Deps, reads = googleReads(db)) {
  const { client, agenda, agendaOn, inbox, profile } = reads;
  const local = `http://localhost:${config.port}`;
  const redirectUri = `${local}/auth/google/callback`;
  const off = () => ({ disabled: true as const });

  const auth = new Hono()
    .get("/start", async (c) => {
      if (new URL(c.req.url).origin !== local) return c.redirect(`${local}/auth/google/start`);
      const { verifier, challenge } = pkce();
      const state = createState(`${local}/`, Date.now(), verifier);
      setCookie(c, COOKIE, state, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/auth/google",
        maxAge: 600,
      });
      return c.redirect(await authorizeUrl(state, redirectUri, challenge));
    })
    .get("/callback", async (c) => {
      const error = c.req.query("error");
      if (error) return oauthPage("Google rechazó la autorización", error);
      const verdict = consumeState(c.req.query("state"), getCookie(c, COOKIE));
      deleteCookie(c, COOKIE, { path: "/auth/google" });
      if (!verdict.ok) return oauthPage("Estado OAuth inválido", verdict.reason);
      const code = c.req.query("code");
      if (!code) return oauthPage("Falta el código de autorización", "code missing");
      try {
        const tokens = await exchangeCode(code, redirectUri, verdict.verifier);
        // Google lets the user untick a scope on its consent screen; only sorting needs modify.
        const missing = READ_SCOPES.filter((s) => !tokens.scope.split(" ").includes(s));
        if (missing.length > 0)
          return oauthPage("Faltan permisos de Google", missing.join("\n"), 409);
        const me = await fetchProfile(tokens.accessToken);
        saveConnection(db, "google", {
          accountId: me.emailAddress,
          displayName: me.emailAddress,
          scopes: tokens.scope,
        });
        agenda.invalidate();
        agendaOn.invalidate();
        inbox.invalidate();
        profile.invalidate();
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        return oauthPage("Google no respondió", err.message, 502);
      }
      return c.redirect(verdict.returnTo);
    });

  const api = new Hono()
    // Today is kept a minute; another day (`?day=YYYY-MM-DD`) is read when asked.
    .get("/agenda", async (c) => {
      if (!config.providers.google) return c.json(off());
      const day = c.req.query("day");
      if (day === undefined)
        return c.json({ events: await agenda.get({ fresh: c.req.query("fresh") === "1" }) });
      const at = parseDay(day);
      if (!at) return c.json({ error: "invalid_day", detail: "day is YYYY-MM-DD" }, 400);
      return c.json({ events: await agendaOn.of(day, () => client.agenda(at)).get() });
    })
    .get("/inbox", async (c) =>
      config.providers.google
        ? c.json(await inbox.get({ fresh: c.req.query("fresh") === "1" }))
        : c.json(off()),
    )
    .get("/cleanup/profile", async (c) =>
      config.providers.google
        ? c.json(await profile.get({ fresh: c.req.query("fresh") === "1" }))
        : c.json(off()),
    )
    .get("/threads/:id", async (c) => {
      const id = c.req.param("id");
      if (!THREAD_ID.test(id)) return c.json({ error: "invalid_thread" }, 400);
      return config.providers.google ? c.json(await client.thread(id)) : c.json(off());
    });

  return { auth, api };
}
