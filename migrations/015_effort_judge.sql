-- Passes of the weekly effort judge (server/features/usage/judge.ts): Sonnet reads each Log Pose
-- turn of a span and says the effort level and advisor gauge it would have set. Consumo compares
-- that with the mod's choice and with the level the turn ran at.

-- state: running → done, capped (the budget ran out part way) or failed. `trigger` is 'auto' for
-- the Monday pass and 'manual' for the button. `verdicts` is the JSON list of one entry per
-- judged turn, keyed by session id and submit time; it holds no prompt text. `turns` are the
-- span's turns with a prompt found in its transcript, `unmatched` those without one. `usd` is
-- what the calls reported spending.
CREATE TABLE effort_judge_runs (
  id TEXT PRIMARY KEY,
  span_from TEXT NOT NULL,
  span_to TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'capped', 'failed')),
  turns INTEGER NOT NULL DEFAULT 0,
  judged INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  verdicts TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX effort_judge_runs_span ON effort_judge_runs (span_from, span_to);
