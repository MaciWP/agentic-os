-- The effort level a Claude call ran at, as its transcript line says it ('low', 'medium',
-- 'high', 'xhigh', ...); '' when the line says none: an older Claude Code, another harness, or
-- an advisor call, which runs at its own.
ALTER TABLE agent_usage ADD COLUMN effort TEXT NOT NULL DEFAULT '';

-- Read Claude's transcripts again so past calls get theirs. Rows keep the harness's own ids, so
-- the second read replaces them instead of adding to them.
DELETE FROM agent_sources WHERE harness = 'claude';
