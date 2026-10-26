CREATE TABLE coordination_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'consultation')),
  request_key TEXT NOT NULL UNIQUE,
  request_body TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE coordination_reservations (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);
CREATE TABLE coordination_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO coordination_revision VALUES (1, 0);
CREATE TABLE coordination_audit (id TEXT PRIMARY KEY, body TEXT NOT NULL);
