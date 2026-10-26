import { join } from "node:path";
import { listFolders } from "../files/browse.ts";
import { runGit } from "../git/run.ts";
import { isRepoRoot } from "../git/status.ts";
import { type CodeWhere, confine } from "./read.ts";

export const FILES_LIMIT = 50_000;
const LS_BYTES = 16 * 1024 * 1024;

export type CodeFiles = { files: string[]; truncated: boolean; git: boolean };

// Every file quick open can offer, as git sees them: tracked and untracked, never ignored, so
// node_modules and builds stay out. An env's root is no repo; its checkouts one level down are.
export async function listAllFiles(where: CodeWhere): Promise<CodeFiles> {
  const { bin, env } = where;
  if (!bin) return { files: [], truncated: false, git: false };
  const { path: base } = await confine(where.cwd, "");
  const at = { bin, cwd: base, env };
  const repos = (await isRepoRoot(at))
    ? [""]
    : (await listFolders(base)).entries.filter((e) => e.git).map((e) => e.name);
  const files: string[] = [];
  let truncated = false;
  for (const prefix of repos) {
    const { out, truncated: cut } = await runGit(
      bin,
      join(base, prefix),
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
      { env, maxBytes: LS_BYTES },
    );
    truncated ||= cut;
    const paths = out.split("\0");
    // Cut at the byte cap, the last path may be half of one.
    if (cut) paths.pop();
    for (const f of paths) {
      if (!f) continue;
      if (files.length >= FILES_LIMIT) {
        truncated = true;
        break;
      }
      files.push(prefix ? `${prefix}/${f}` : f);
    }
  }
  return { files, truncated, git: repos.length > 0 };
}
