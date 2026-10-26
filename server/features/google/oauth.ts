import type { Database } from "bun:sqlite";
import { oauthTokens, ReconnectError } from "../../oauth.ts";
import { getSecret } from "../../secrets.ts";

// What every read needs (the agenda and the inbox): a consent without them is refused.
export const READ_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
// Lets the mail categorizer move threads to a label or to the trash. Gmail's modify scope also
// allows sending; the server only calls threads.modify and threads.trash (ADR 0002). Optional:
// a consent without it still reads, and sorting asks for a reconnect.
export const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const SCOPES = [...READ_SCOPES, MODIFY_SCOPE];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export class GoogleReconnect extends ReconnectError {
  constructor(reason: string) {
    super("google", `Google needs to be connected: ${reason}`);
  }
}

// A Desktop client: its secret is not confidential, so PKCE protects the exchange.
async function appCredentials() {
  const clientId = await getSecret("google.client_id");
  const clientSecret = await getSecret("google.client_secret");
  if (!clientId || !clientSecret)
    throw new GoogleReconnect("OAuth app credentials missing in Keychain");
  return { clientId, clientSecret };
}

export const { exchangeCode, getAccessToken } = oauthTokens({
  provider: "google",
  label: "Google",
  tokenUrl: "https://oauth2.googleapis.com/token",
  tokensKey: "google.tokens",
  encoding: "form",
  credentials: appCredentials,
  reconnect: (reason) => new GoogleReconnect(reason),
});

export async function authorizeUrl(
  state: string,
  redirectUri: string,
  challenge: string,
): Promise<string> {
  const { clientId } = await appCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    // A refresh token on every consent, so a reconnect replaces a revoked one.
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

// The scopes the connected account granted at its last consent.
export function grantedScopes(db: Database): string[] {
  const row = db
    .query<{ scopes: string | null }, []>(
      "SELECT scopes FROM connections WHERE provider = 'google'",
    )
    .get();
  return row?.scopes?.split(" ") ?? [];
}

export function googleConnection(db: Database): { email: string } | null {
  return (
    db
      .query<{ email: string }, []>(
        "SELECT account_id AS email FROM connections WHERE provider = 'google'",
      )
      .get() ?? null
  );
}
