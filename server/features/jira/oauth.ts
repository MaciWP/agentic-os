import type { Database } from "bun:sqlite";
import { z } from "zod";
import { deadline } from "../../deadline.ts";
import { log } from "../../log.ts";
import { oauthTokens, ReconnectError, saveConnection as saveShared } from "../../oauth.ts";
import { ProviderError, parseProvider } from "../../provider-error.ts";
import { getSecret } from "../../secrets.ts";

export { consumeState, createState } from "../../oauth.ts";

export const SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"];
const AUTH_URL = "https://auth.atlassian.com/authorize";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

export class ReconnectRequired extends ReconnectError {
  constructor(reason: string) {
    super("jira", `Jira needs to be reconnected: ${reason}`);
  }
}

async function appCredentials() {
  const clientId = await getSecret("atlassian.client_id");
  const clientSecret = await getSecret("atlassian.client_secret");
  if (!clientId || !clientSecret)
    throw new ReconnectRequired("OAuth app credentials missing in Keychain");
  return { clientId, clientSecret };
}

const tokens = oauthTokens({
  provider: "jira",
  label: "Atlassian",
  tokenUrl: "https://auth.atlassian.com/oauth/token",
  tokensKey: "atlassian.tokens",
  encoding: "json",
  credentials: appCredentials,
  reconnect: (reason) => new ReconnectRequired(reason),
});
export const { exchangeCode, getAccessToken } = tokens;
const atlassian = tokens.call;

const json = async (what: string, res: Response): Promise<unknown> =>
  res.json().catch(() => {
    throw new ProviderError("jira", 502, `Atlassian ${what} sent invalid JSON`);
  });

const Resource = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
});
export type Resource = z.infer<typeof Resource>;

export async function authorizeUrl(state: string, redirectUri: string): Promise<string> {
  const { clientId } = await appCredentials();
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId,
    scope: SCOPES.join(" "),
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params}`;
}

// --- site selection -----------------------------------------------------------------------------

function normalizeSite(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

// The endpoint can list the same site twice (one entry per product); require Jira scopes.
export function pickJiraResource(resources: Resource[], site: string): Resource | null {
  const wanted = normalizeSite(site);
  return (
    resources.find((r) => normalizeSite(r.url) === wanted && r.scopes.includes("read:jira-work")) ??
    null
  );
}

export async function listResources(accessToken: string): Promise<Resource[]> {
  const res = await atlassian("accessible-resources", RESOURCES_URL, {
    signal: deadline(),
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    log("jira").warn(`accessible-resources ${res.status}`, {
      body: (await res.text().catch(() => "")).slice(0, 200),
    });
    throw new ProviderError("jira", res.status, `Atlassian accessible-resources ${res.status}`);
  }
  return parseProvider("jira", z.array(Resource), await json("accessible-resources", res));
}

const Myself = z.object({ accountId: z.string(), displayName: z.string() });

// Who the new token belongs to, asked once when the OAuth callback lands.
export async function fetchMyself(
  accessToken: string,
  cloudId: string,
): Promise<z.infer<typeof Myself>> {
  const res = await atlassian(
    "/myself",
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
    {
      signal: deadline(),
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    },
  );
  if (!res.ok) {
    log("jira").warn(`/myself ${res.status}`, {
      body: (await res.text().catch(() => "")).slice(0, 300),
    });
    throw new ProviderError("jira", res.status, `Jira /myself ${res.status}`);
  }
  return parseProvider("jira", Myself, await json("/myself", res));
}

export const saveConnection = (
  db: Database,
  c: { accountId: string; displayName: string; siteUrl: string; cloudId: string; scopes: string },
) => saveShared(db, "atlassian", c);

export function jiraConnection(
  db: Database,
): { cloudId: string; accountId: string; siteUrl: string } | null {
  return (
    db
      .query<{ cloudId: string; accountId: string; siteUrl: string }, []>(
        "SELECT cloud_id AS cloudId, account_id AS accountId, site_url AS siteUrl FROM connections WHERE provider = 'atlassian'",
      )
      .get() ?? null
  );
}
