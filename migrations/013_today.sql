-- Inicio's «Hoy» (server/features/objectives, server/features/meetings, the mail categorizer).

-- A goal as a task of the day: when it is due, how urgent it is, where the user put it in the
-- list, what it is about (a ticket key) and where it came from (a mail, a meeting note) so the
-- same source never makes it twice. Nothing expires: an open task stays until it is closed.
ALTER TABLE objectives ADD COLUMN due_on TEXT
  CHECK (due_on IS NULL OR due_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE objectives ADD COLUMN due_hm TEXT
  CHECK (due_hm IS NULL OR due_hm GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE objectives ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1));
ALTER TABLE objectives ADD COLUMN position REAL;
ALTER TABLE objectives ADD COLUMN about TEXT CHECK (about IS NULL OR length(about) <= 200);
ALTER TABLE objectives ADD COLUMN source TEXT;
ALTER TABLE objectives ADD COLUMN source_key TEXT;
-- NULLs are distinct here, so only sourced tasks are unique.
CREATE UNIQUE INDEX objectives_source ON objectives (source, source_key);

-- A meeting seen in a calendar, kept until the user closes it: yesterday's unclosed meeting
-- stays on «Hoy» after the calendar stops returning it. Google has no occurrence (each instance
-- has its own id); Outlook repeats an id across a series, so the instance's start tells them
-- apart. note_id names its Markdown note (server/features/memory).
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('google', 'outlook')),
  event_key TEXT NOT NULL,
  occurrence TEXT NOT NULL DEFAULT '',
  title TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  note_id TEXT,
  closed_at TEXT,
  UNIQUE (source, event_key, occurrence)
);
CREATE INDEX meetings_open ON meetings (starts_at) WHERE closed_at IS NULL;

-- What a mail categorizer agent proposed for one account: the user reviews it and the server
-- applies what they kept. `items` is JSON, read through zod.
CREATE TABLE mail_proposals (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL CHECK (account IN ('work', 'personal')),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'discarded')),
  items TEXT NOT NULL
);
