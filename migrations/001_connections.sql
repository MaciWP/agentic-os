-- Provider accounts. Tokens never live here: they stay in the Keychain.
CREATE TABLE connections (
  provider TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  display_name TEXT,
  site_url TEXT,
  cloud_id TEXT,
  scopes TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
