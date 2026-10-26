// refresh: rebuilds the UI that the user's server (4317) serves from dist/, in one step.
// The server reads dist/ on every request, so it needs no restart. A dist/ already built from
// the current sources (its stamp, scripts/web-hash.ts) is kept as it is; `--force` builds anyway.
// The build goes to
// dist.next/ and replaces dist/ only once it is complete, so a reload never sees half of one.
// The previous build's assets from the last day are carried over, so a page that is already
// open still loads its lazy chunks.
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CARRIED_ASSETS } from "../server/features/system/update.ts";
import { lock } from "./lock.ts";
import { STAMP, webSourceHash } from "./web-hash.ts";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const NEXT = join(ROOT, "dist.next");
const PREV = join(ROOT, "dist.prev");
const DAY = 24 * 60 * 60_000;

const release = await lock(join(ROOT, "dist.lock"), "refresh");
try {
  const source = webSourceHash(ROOT);
  let built = "";
  try {
    built = readFileSync(join(DIST, STAMP), "utf8").trim();
  } catch {}
  // A worker gets dist/ from the hub's update and has no web/ to build it from.
  const sourceless = !existsSync(join(ROOT, "web"));
  if (sourceless || (built === source && !process.argv.includes("--force"))) {
    console.log(
      sourceless
        ? "dist/ is current: no web/ here, it comes from the hub"
        : "dist/ is current: nothing to build",
    );
    // exit skips `finally`: the lock goes first.
    release();
    process.exit(0);
  }
  const build = Bun.spawnSync(["bunx", "vite", "build", "--outDir", NEXT, "--emptyOutDir"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error("the build failed; dist/ is unchanged");

  const old = join(DIST, "assets");
  const carried: string[] = [];
  if (existsSync(old))
    for (const name of readdirSync(old)) {
      const from = join(old, name);
      const to = join(NEXT, "assets", name);
      if (!existsSync(to) && Date.now() - statSync(from).mtimeMs < DAY) {
        cpSync(from, to, { preserveTimestamps: true });
        carried.push(name);
      }
    }
  // A worker's update leaves these out (packBundle).
  writeFileSync(join(NEXT, CARRIED_ASSETS), `${JSON.stringify(carried)}\n`);
  // Last, so only a complete build carries it.
  writeFileSync(join(NEXT, STAMP), `${source}\n`);

  rmSync(PREV, { recursive: true, force: true });
  if (existsSync(DIST)) renameSync(DIST, PREV);
  renameSync(NEXT, DIST);
  rmSync(PREV, { recursive: true, force: true });
  console.log("dist/ refreshed: reload http://agentic-os.localhost:4317");
} finally {
  release();
}
