import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect } from "@playwright/test";

// Git for the throwaway checkouts the suites that write build: no user config, a fixed
// identity, so a run never reads or signs with the user's own setup.
const gitEnv = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" }).toString().trim();
export const commit = (cwd: string, file: string, text = `${file}\n`) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
};

// A rebuild deletes the fixture's parent folder: it must be a folder of its own inside the
// temp folder, never the temp folder itself, and no symlink out of it.
export function throwawayParent(work: string) {
  const tmp = realpathSync(tmpdir());
  const parent = resolve(dirname(work));
  expect(parent.startsWith(`${tmp}/`), `fixture's parent inside ${tmp}`).toBe(true);
  if (existsSync(parent)) expect(realpathSync(parent)).toBe(parent);
  return parent;
}
