// How long a request ledger remembers a request id. A retry inside this window replays the
// first result; older rows are pruned on the next write. Seven days covers a client that
// retries after a night or a weekend offline, well past the 24 h retry window we promise.
export const LEDGER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// How long Consumo keeps model calls and harness events: a year and a month, so a month can
// still be read against the same month a year before.
export const USAGE_KEEP_MS = 400 * 24 * 60 * 60 * 1000;
export const keptSince = (now = Date.now(), keep = LEDGER_KEEP_MS) =>
  new Date(now - keep).toISOString();
// How long a copy saved before a destructive action (a discard, a note delete) is kept in
// data/recovery/: long enough to notice the mistake, pruned on the next save.
export const RECOVERY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// How long a ticket's kickoff context stays in data/kickoff/: its date is the last round's, so
// past it the next round reads as the first. Pruned when any round writes its own.
export const KICKOFF_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
