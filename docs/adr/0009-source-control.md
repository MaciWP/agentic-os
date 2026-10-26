# ADR 0009 — Source control: stage, commit and push

Status: accepted (2026-10-06). Extends ADR 0005 ("Acting on the tree"), which
kept git read-only apart from fetch and fast-forward.

## Context

The Git view lived in the 440 px Mesa drawer: a flat list of changed files and a
diff without line numbers. Staging, committing and pushing still meant leaving
the app for a shell or Orca. The user wants what Orca's Source Control does (a
file tree, a clear diff, stage by file or hunk, commit, pull, push) in a window
beside the terminals.

## Decision

- **A Mesa tile per checkout ("a fake terminal").** Git lives among the
  terminals, not in the drawer nor in a popup: "Git" in a tree row's "+" (the
  drawer's button until the drawer went, ADR 0006) adds the tile `git:<encoded location>` (ADR 0006), so several checkouts show at
  once, placed and resized like terminals. A wide tile shows the source-control
  column beside the picked file's diff; below 44rem it shows one at a time, with
  "Ficheros" to go back. j/k file, n/p hunk and s stage answer only while the
  focus is in that tile. A first version had a `/git` popup and a Git tab in the
  drawer; both were dropped the same day for this.
- **Freshness.** Agents edit files without telling the app. While the page is
  visible each git tile reads its status and open diff every 5 s, the same
  exception the agent monitor has (ADR 0007); a hidden tab reads nothing. Every
  write publishes `projects`.
- **New files apart.** Untracked files have their own group, "Sin seguimiento",
  as in Orca: staged or left there, they block nothing (commit takes only what
  is staged; a fast-forward stops only where git says a file would be
  overwritten), and a staged new file taken back returns to it.
- **What the client sends is compared, never passed on.** Every write route
  (`/stage`, `/unstage`, `/resolve`, `/discard`, `/hunk`, `/commit`, `/push`)
  reads the status again and acts only on the paths it lists. Every write runs
  `git --literal-pathspecs`, so `a[1].ts` or `:x` are never patterns, inside the
  per-checkout `exclusive` of ADR 0005. A held `index.lock` (an agent running
  git in the same checkout) is a 409 `locked`, not a failure.
- **Terminals inside do not block these writes.** An agent working in the
  checkout is why they exist. Fast-forward keeps its refusals (terminal inside,
  env checkout, diverged).
- **Stage.** `add -A` for files, folders and groups (the client expands a folder
  into listed paths). A nested repo or empty dir (trailing slash) is refused: it
  would record a gitlink. Unstage is `restore --staged` (with a rename's original
  path), or `rm --cached` before the first commit.
- **Conflicts.** Never staged by the plain action; "Marcar como resuelto" stages
  one file and is refused while a line still opens or closes a conflict.
- **Hunks.** The diff answer carries each hunk's sha1. A hunk is staged with
  `apply --cached` (taken back with `-R`) after the server reads the diff again
  and finds the same digest; a moved file is `stale`. Only plain content
  changes: a new, deleted, renamed, binary or mode-changed file, a truncated
  diff and a conflict go whole. Diffs use fixed `a/`/`b/` prefixes and apply
  with `--whitespace=nowarn`, so the user's `diff.noprefix` or
  `apply.whitespace=fix` cannot change what is staged.
- **Discard.** Only the unstaged side of tracked files (`restore --worktree`),
  behind a confirm dialog and `confirm: true` in the body. New files are never
  deleted from the app.
- **Commit.** What is staged, the message on stdin (`commit --cleanup=strip -F -`),
  120 s for hooks and signing. Never `--no-verify`, no trailers or footers.
  Refused with conflicts or nothing staged; a missing identity and a failing
  hook come back in git's words. No amend.
- **Push.** The branch's upstream remote and merge ref, named in full whatever
  `push.default` says; without an upstream, the only remote (or `origin`) under
  the branch's own name with `-u`. Never a force push: a rejected push is a 409
  `behind` that says to bring the remote first. A branch following a local
  branch is refused. Pull stays the fast-forward of ADR 0005.

**Amendment (2026-10-10): notes on the diff.** A click on a line number opens a
note under it; Shift+click on another line of the hunk makes a range (at most 20
lines). A note has a kind (`cambio`, `pregunta`, `nit`, `no tocar`) and its text,
and quotes its diff lines with their marks: the quote anchors it while numbers
move, and a note whose lines left the diff shows at the top of it. The notes are
the page's, per checkout, in `aos.diff-notes:<location>` (owner
`web/features/git/notes.ts`, ADR 0013); a file row counts its pending ones. The
send bar pastes every pending note of the checkout into a running agent in that
same location through `POST /api/terminals/:id/bring` with `{ notes }`, never
followed by Enter. The server builds the text (`notes-prompt.ts`): one block per
file, each note with its kind, lines and quote, under the terminal's own
location; a shell or env terminal gets 409 `not_an_agent`. Once sent, a note
reads `tocada` when its quoted lines are no longer in that side's diff and `sin
tocar` while they are; touched says the lines changed, not that the change is
right.

## Consequences

- Each git tile costs one `git status` and one `git diff` every 5 s while the
  page is visible; at most six tiles.
- A commit or push started while an agent in that checkout runs git may be
  refused as `locked`; it is not retried on its own.
- Line-level staging, amend, force push with lease, deleting new files and
  syntax highlighting are left out until asked for.

## Verification

`server/features/git/stage.test.ts` runs real git on temp repos with a bare
remote: literal names (`a[1].ts`, `:odd`, spaces), made-up paths ignored or
refused, deletions and renames, unstage before the first commit, a nested repo,
a held index lock, conflicts and their markers, discard keeping staged parts and
new files, the middle of three hunks staged and taken back alone, a stale
digest, a commit message with quotes, a failing pre-commit hook, the first push
setting the upstream, a plain second push, a rejected push, a detached head, no
remote, the routes' 400s and 409s and a foreign Origin refused by the local
guard. `web/features/git/diff.test.ts` (line numbers, word pairs, side-by-side
rows), `tree.test.ts`, `source-control.test.tsx` (groups with the untracked one,
actions per side, commit states, push labels) and `tile.test.tsx` (line numbers,
word marks, the hunk action, the narrow start). `e2e/git.e2e.ts` opens the tile
from a row's "+", matches its rows to `git status`, reads a diff narrow and wide,
and shows two checkouts at once. `e2e/git-notes.e2e.ts` writes a note on a
range, keeps it across a reload with its file's count, and finds the send
button off with no agent in the checkout; `bring.test.ts` covers the notes
body and its refusals.
