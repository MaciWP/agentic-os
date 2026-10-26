-- What an agent terminal needs to be resumed after the PTY host restarts: the harness's own
-- session id (followed while it runs, since /clear starts a new one), the user's name for the
-- terminal and the launch options. `resumes` counts automatic resumes, so a host that keeps
-- dying cannot relaunch the same session forever.
ALTER TABLE terminal_sessions ADD COLUMN session_id TEXT;
ALTER TABLE terminal_sessions ADD COLUMN name TEXT;
ALTER TABLE terminal_sessions ADD COLUMN model TEXT;
ALTER TABLE terminal_sessions ADD COLUMN effort TEXT;
ALTER TABLE terminal_sessions ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0;
