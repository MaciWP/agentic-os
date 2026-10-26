-- Index of the Markdown documents the app shows: harness memories (read-only) and the
-- app's own notes, memory and prompts. The files are the truth; this is rebuilt from them.
CREATE TABLE memory_docs (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  rel TEXT NOT NULL,
  path TEXT NOT NULL,
  -- 1 only for named single files, which may be symlinks; tree files never are.
  follow INTEGER NOT NULL CHECK (follow IN (0, 1)),
  title TEXT NOT NULL,
  description TEXT,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX memory_docs_source ON memory_docs (source);

-- Full-text search over the same documents; rowid = memory_docs.rowid.
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
