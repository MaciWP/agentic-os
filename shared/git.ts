// X is the index side, Y the worktree side, as `git status --porcelain=v2` prints them.
export const isStaged = (f: { x: string }) => f.x !== "." && f.x !== "?";
export const isUnstaged = (f: { y: string }) => f.y !== ".";
