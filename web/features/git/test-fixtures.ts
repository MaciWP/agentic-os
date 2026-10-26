import type { GitStatus } from "./queries.ts";

// A checkout with a change on each side, a rename and a new file.
export const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  repo: true,
  versions: {},
  branch: "main",
  oid: "abc",
  upstream: "origin/main",
  ahead: 1,
  behind: 2,
  truncated: false,
  files: [
    { path: "src/a.txt", orig: null, x: ".", y: "M", kind: "changed" },
    { path: "both.txt", orig: null, x: "M", y: "M", kind: "changed" },
    { path: "new name.txt", orig: "old name.txt", x: "R", y: ".", kind: "renamed" },
    { path: "fresh/x.txt", orig: null, x: "?", y: "?", kind: "untracked" },
  ],
  ...over,
});
