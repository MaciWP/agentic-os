import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import { z } from "zod";
import { deadline, OPERATION_MS, timedOut, within } from "./deadline.ts";
import { jsonOrNull } from "./json.ts";
import { log } from "./log.ts";
import { netCause, ProviderError, parseProvider } from "./provider-error.ts";
import { getSecret, setSecret } from "./secrets.ts";
import { pathTemplate, traced } from "./telemetry/span.ts";

// The OAuth plumbing every provider shares (Atlassian, Google, Microsoft): login state, the
// Keychain token bundle and its single-flight refresh. Each provider brings its endpoints.

const STATE_TTL_MS = 10 * 60_000;

// A provider failure only the user can fix, by connecting again. The message is always this
// server's own words, never the provider's.
export class ReconnectError extends ProviderError {
  constructor(provider: string, message: string) {
    super(provider, 401, message);
  }
}

type SecretName = Parameters<typeof getSecret>[0];

export type OAuthProvider = {
  provider: string;
  label: string;
  tokenUrl: string;
  // Keychain entry holding the token bundle.
  tokensKey: SecretName;
  // Atlassian takes JSON; Google and Microsoft take a form body.
  encoding: "json" | "form";
  // A public client (PKCE) has no secret.
  credentials: () => Promise<{ clientId: string; clientSecret?: string }>;
  reconnect: (reason: string) => ReconnectError;
};

// --- state: single use, 10 minutes, bound to a cookie ---------------------------------------

type PendingState = { expiresAt: number; returnTo: string; verifier?: string };
const pending = new Map<string, PendingState>();

export function createState(returnTo: string, now = Date.now(), verifier?: string): string {
  for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  const state = crypto.randomUUID();
  pending.set(state, { expiresAt: now + STATE_TTL_MS, returnTo, verifier });
  return state;
}

export function consumeState(
  state: string | undefined,
  cookie: string | undefined,
  now = Date.now(),
): { ok: true; returnTo: string; verifier?: string } | { ok: false; reason: string } {
  if (!state || !cookie || state !== cookie) return { ok: false, reason: "state_mismatch" };
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry) return { ok: false, reason: "state_unknown_or_used" };
  if (entry.expiresAt <= now) return { ok: false, reason: "state_expired" };
  return { ok: true, returnTo: entry.returnTo, verifier: entry.verifier };
}

// RFC 7636, S256.
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// Who a provider's token belongs to; the tokens themselves stay in the Keychain.
export function saveConnection(
  db: Database,
  provider: string,
  c: { accountId: string; displayName: string; siteUrl?: string; cloudId?: string; scopes: string },
) {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO connections (provider, account_id, display_name, site_url, cloud_id, scopes, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id, display_name = excluded.display_name,
       site_url = excluded.site_url, cloud_id = excluded.cloud_id, scopes = excluded.scopes, updated_at = excluded.updated_at`,
  ).run(
    provider,
    c.accountId,
    c.displayName,
    c.siteUrl ?? null,
    c.cloudId ?? null,
    c.scopes,
    now,
    now,
  );
}

// A browser lands on an OAuth callback: a failure is a page in the user's tab, never JSON.
export function oauthPage(
  title: string,
  body: string,
  status: 400 | 409 | 502 = 400,
  link: { href: string; label: string } = { href: "/", label: "Volver" },
) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:14px system-ui;padding:24px"><h1>${esc(title)}</h1><pre>${esc(body)}</pre><p><a href="${esc(link.href)}">${esc(link.label)}</a></p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// --- tokens ------------------------------------------------------------------------------------

// A refresh may omit `refresh_token` (Google keeps the old one); a code exchange may not.
const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number(),
  scope: z.string().default(""),
});

const TokenBundle = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  scope: z.string(),
});
export type TokenBundle = z.infer<typeof TokenBundle>;

const fresh = (b: TokenBundle) => b.expiresAt - 60_000 > Date.now();

export function oauthTokens(p: OAuthProvider) {
  // The provider's auth endpoints, failed or unreachable, as provider errors.
  const call = (what: string, url: string, init: RequestInit): Promise<Response> =>
    fetch(url, init).catch((err) => {
      throw init.signal?.aborted
        ? new ProviderError(p.provider, 504, `${p.label} ${what} did not answer in time`)
        : new ProviderError(
            p.provider,
            503,
            `${p.label} ${what} could not be reached: ${netCause(err)}`,
          );
    });

  // Its body stays in the server log: a token endpoint's answer must not reach a client.
  async function postToken(body: Record<string, string>, previous?: string): Promise<TokenBundle> {
    // Shared by every waiting caller, so bounded on its own.
    const res = await call("token endpoint", p.tokenUrl, {
      signal: deadline(),
      method: "POST",
      headers: {
        "content-type":
          p.encoding === "json" ? "application/json" : "application/x-www-form-urlencoded",
      },
      body: p.encoding === "json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log(p.provider).warn(`token endpoint ${res.status}`, { body: text.slice(0, 200) });
      if (text.includes("invalid_grant") || res.status === 403)
        throw p.reconnect(`${p.label} refused the stored grant`);
      throw new ProviderError(p.provider, res.status, `${p.label} token endpoint ${res.status}`);
    }
    const raw = await res.json().catch(() => {
      throw new ProviderError(p.provider, 502, `${p.label} token endpoint sent invalid JSON`);
    });
    const t = parseProvider(p.provider, TokenResponse, raw);
    const refreshToken = t.refresh_token ?? previous;
    if (!refreshToken) throw p.reconnect(`${p.label} sent no refresh token`);
    return {
      accessToken: t.access_token,
      refreshToken,
      expiresAt: Date.now() + t.expires_in * 1000,
      scope: t.scope,
    };
  }

  const saveBundle = (bundle: TokenBundle) => setSecret(p.tokensKey, JSON.stringify(bundle));

  async function loadBundle(): Promise<TokenBundle> {
    const raw = await getSecret(p.tokensKey);
    if (!raw) throw p.reconnect("no tokens stored");
    return TokenBundle.parse(JSON.parse(raw));
  }

  const client = async (): Promise<Record<string, string>> => {
    const { clientId, clientSecret } = await p.credentials();
    return clientSecret
      ? { client_id: clientId, client_secret: clientSecret }
      : { client_id: clientId };
  };

  async function exchangeCode(
    code: string,
    redirectUri: string,
    verifier?: string,
  ): Promise<TokenBundle> {
    const bundle = await postToken({
      grant_type: "authorization_code",
      ...(await client()),
      code,
      redirect_uri: redirectUri,
      ...(verifier ? { code_verifier: verifier } : {}),
    });
    await saveBundle(bundle);
    return bundle;
  }

  let refreshing: Promise<TokenBundle> | null = null;

  // One refresh in flight; the rotated bundle is persisted before any waiter gets the token.
  // The bundle is re-read inside the refresh: a caller that read it before another refresh
  // finished must not spend the already-rotated refresh token. `signal` bounds this caller's
  // wait only; the refresh itself goes on for the others.
  async function getAccessToken(
    opts: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (refreshing) return (await within(refreshing, opts.signal)).accessToken;
    const seen = await loadBundle();
    if (!opts.force && fresh(seen)) return seen.accessToken;
    refreshing ??= (async () => {
      try {
        const bundle = await loadBundle();
        if (bundle.refreshToken !== seen.refreshToken && fresh(bundle)) return bundle;
        const next = await postToken(
          { grant_type: "refresh_token", ...(await client()), refresh_token: bundle.refreshToken },
          bundle.refreshToken,
        );
        await saveBundle(next);
        return next;
      } finally {
        refreshing = null;
      }
    })();
    return (await within(refreshing, opts.signal)).accessToken;
  }

  return { exchangeCode, getAccessToken, call };
}

// Google-style error bodies name a reason: `{ error: { errors: [{ reason }] } }`.
const ErrorBody = z.looseObject({
  error: z.looseObject({
    errors: z.array(z.looseObject({ reason: z.string() })).min(1),
  }),
});
const reasonOf = (body: string) =>
  ErrorBody.safeParse(jsonOrNull(body)).data?.error.errors[0]?.reason;

// One authorised call to a provider's API: the token, one retry with a forced refresh on 401,
// typed errors and the answer checked by `schema`. `init.signal` is the operation's deadline;
// without one, this call gets its own. The provider's body stays in the server log: an
// upstream answer never reaches a client.
export async function providerRequest<S extends z.ZodType>(
  p: {
    provider: string;
    label: string;
    getAccessToken: (opts: { force?: boolean; signal?: AbortSignal }) => Promise<string>;
  },
  schema: S,
  url: string,
  path: string,
  init: RequestInit = {},
): Promise<z.infer<S>> {
  const method = init.method ?? "GET";
  return traced(`${p.provider} ${method} ${pathTemplate(path)}`, p.provider, {}, (span) =>
    request(p, schema, url, path, init, span),
  );
}

async function request<S extends z.ZodType>(
  p: Parameters<typeof providerRequest>[0],
  schema: S,
  url: string,
  path: string,
  init: RequestInit,
  span: Span,
): Promise<z.infer<S>> {
  const signal = init.signal ?? deadline();
  // A network failure is a provider error; a timeout is left to the catch below.
  const send = async (token: string) =>
    fetch(url, {
      ...init,
      signal,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
    }).catch((err) => {
      if (timedOut(err, signal)) throw err;
      throw new ProviderError(
        p.provider,
        503,
        `${p.label} could not be reached on ${path}: ${netCause(err)}`,
      );
    });
  try {
    let res = await send(await p.getAccessToken({ signal }));
    if (res.status === 401) {
      span.addEvent("token refreshed after 401");
      res = await send(await p.getAccessToken({ force: true, signal }));
    }
    span.setAttribute("http.response.status_code", res.status);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(p.provider).warn(`${res.status} on ${path}`, { body: body.slice(0, 300) });
      throw new ProviderError(
        p.provider,
        res.status,
        `${p.label} ${res.status} on ${path}`,
        reasonOf(body),
      );
    }
    const value =
      res.status === 204
        ? undefined
        : await res.json().catch(() => {
            throw new ProviderError(p.provider, 502, `${p.label} sent invalid JSON`);
          });
    return parseProvider(p.provider, schema, value);
  } catch (err) {
    if (timedOut(err, signal))
      throw new ProviderError(
        p.provider,
        504,
        `${p.label} did not answer within ${OPERATION_MS / 1000} s on ${path}`,
      );
    throw err;
  }
}
