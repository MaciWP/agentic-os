CREATE TABLE terminal_launch_requests (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE workspace_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE workspace_requests (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL
);
