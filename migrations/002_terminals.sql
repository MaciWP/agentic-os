-- Terminals the app launched. The PTYs live in the server process; this is their record.
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  location TEXT NOT NULL,
  cwd TEXT NOT NULL,
  ticket TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'exited', 'failed', 'lost')),
  exit_code INTEGER,
  signal TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
