-- Request ledgers are pruned by age (server/retention.ts). workspace_requests had no time.
-- SQLite refuses a non-constant default in ADD COLUMN, so existing rows get "now" here.
ALTER TABLE workspace_requests ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
UPDATE workspace_requests SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
