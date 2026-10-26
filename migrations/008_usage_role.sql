-- Which kind of call a row is: 'call' for an ordinary model call, 'advisor' for one the advisor
-- tool made inside another call. Advisor calls live only in Claude's `usage.iterations`.
ALTER TABLE agent_usage ADD COLUMN role TEXT NOT NULL DEFAULT 'call'
  CHECK (role IN ('call', 'advisor'));

-- Read Claude's transcripts again so past advisor calls are counted. Rows keep the harness's
-- own ids, so the second read replaces them instead of adding to them.
DELETE FROM agent_sources WHERE harness = 'claude';
