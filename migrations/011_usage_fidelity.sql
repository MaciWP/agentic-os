-- What Consumo needs to prove its numbers and to read a quota week.
-- IF NOT EXISTS: the server and the PTY host may both apply it on their first start.

-- The cost Claude Code itself counted for a session: the last "cost-state" line of its
-- transcript. Only to check the cost read from the calls against; never the cost shown.
CREATE TABLE IF NOT EXISTS agent_cost_checks (
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- When the process that wrote it started; a resumed session starts it again.
  start_time TEXT NOT NULL,
  total_usd REAL NOT NULL,
  -- {model: dollars} as the harness counted them.
  models TEXT NOT NULL,
  PRIMARY KEY (harness, session_id)
);
CREATE INDEX IF NOT EXISTS agent_cost_checks_start ON agent_cost_checks (start_time);

-- A plan's limit windows over time (Claude: 5 h and the week; Codex: its own), sampled by the
-- server; a row only when the percent or the reset changed.
CREATE TABLE IF NOT EXISTS plan_samples (
  harness TEXT NOT NULL,
  window_minutes INTEGER NOT NULL,
  at TEXT NOT NULL,
  percent REAL,
  reset_at TEXT,
  PRIMARY KEY (harness, window_minutes, at)
);
CREATE INDEX IF NOT EXISTS plan_samples_at ON plan_samples (at);

-- Read Claude's transcripts again so the cost-state lines already written are kept. Rows keep
-- the harness's own ids, so the second read replaces them instead of adding to them.
DELETE FROM agent_sources WHERE harness = 'claude';
