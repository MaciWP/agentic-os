-- What a terminal works on: a Jira ticket or a free-text goal (server/features/objectives).
-- A ticket objective is created the first time it is linked. Objectives are closed, never
-- deleted, so the usage report keeps every key it once attributed.
CREATE TABLE objectives (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ticket', 'goal')),
  ticket TEXT UNIQUE,
  title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK ((kind = 'ticket') = (ticket IS NOT NULL)),
  CHECK (kind = 'ticket' OR title IS NOT NULL)
);

-- The user's choice for a terminal. No row: its launch ticket. objective_id NULL: none.
CREATE TABLE terminal_objectives (
  terminal_id TEXT PRIMARY KEY,
  objective_id INTEGER REFERENCES objectives(id)
);

-- The objective each agent session ran under, kept when the terminal's choice changes later.
CREATE TABLE session_objectives (
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  objective_id INTEGER NOT NULL REFERENCES objectives(id),
  PRIMARY KEY (harness, session_id)
);
