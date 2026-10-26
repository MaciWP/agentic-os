-- Token use and harness events read from the transcripts each harness keeps (ADR 0008), so
-- the cost of a session, a ticket or an env and the use of skills, commands, subagents, tools
-- and hooks can be added up. Counters and names only: never the text of a conversation.
-- IF NOT EXISTS: the server and the PTY host may both apply it on their first start.

-- How far each transcript has been read: bytes up to the last complete line.
CREATE TABLE IF NOT EXISTS agent_sources (
  path TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  read_bytes INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  -- The reader's own JSON: the current model of a Codex rollout, a subagent's type.
  state TEXT
);

-- Where a call or an event happened. The ticket and the env are derived from these when read,
-- so a change in the config re-attributes the whole history.
CREATE TABLE IF NOT EXISTS agent_places (
  id INTEGER PRIMARY KEY,
  cwd TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  UNIQUE (cwd, branch)
);

-- One model call (a Claude message, a Codex response, a Grok turn per model). The id is the
-- harness's own, so reading a line twice never counts it twice. Input excludes the cache.
CREATE TABLE IF NOT EXISTS agent_usage (
  harness TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  place_id INTEGER NOT NULL REFERENCES agent_places (id),
  -- The subagent type that made the call; '' for the main agent.
  agent TEXT NOT NULL DEFAULT '',
  -- The skill Claude attributes the call to; '' for none.
  skill TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  at TEXT NOT NULL,
  input INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cache_write_1h INTEGER NOT NULL,
  output INTEGER NOT NULL,
  PRIMARY KEY (harness, id)
);
CREATE INDEX IF NOT EXISTS agent_usage_at ON agent_usage (at);

-- One harness event: a skill loaded, a command typed, a subagent started, a tool called, a
-- hook that ran, blocked, failed or timed out.
CREATE TABLE IF NOT EXISTS agent_events (
  harness TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'command', 'subagent', 'tool', 'hook')),
  session_id TEXT NOT NULL,
  place_id INTEGER NOT NULL REFERENCES agent_places (id),
  agent TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  -- skill: ''; subagent: the model asked for ('' inherits); hook: ok, block, error, timeout.
  detail TEXT NOT NULL DEFAULT '',
  ms INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (harness, id, kind)
);
CREATE INDEX IF NOT EXISTS agent_events_at ON agent_events (at);
