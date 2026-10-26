// The only module that touches credentials. Values live in the macOS Keychain
// under service "agentic-os"; nothing here logs or returns them to HTTP.
const SERVICE = "agentic-os";

export const SECRET_NAMES = [
  "atlassian.client_id",
  "atlassian.client_secret",
  "atlassian.tokens",
  "claude.oauth_token",
  "machines.tokens",
  "anthropic.api_key",
  "google.client_id",
  "google.client_secret",
  "google.tokens",
  "microsoft.client_id",
  "microsoft.tokens",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

export async function getSecret(name: SecretName): Promise<string | null> {
  return Bun.secrets.get({ service: SERVICE, name });
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name, value });
}
