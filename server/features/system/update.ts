import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../../run.ts";

// A start that found another server on the data dir: not the new code's fault.
const LOCK_BUSY = 3;

// How the hub (the Mac) keeps a worker's code the same as its own: it packs what a server
// needs, sends it with the pairing token, and the worker unpacks it beside the app, checks it
// would start, copies it over the app and restarts. Nothing in the app changes before that
// check passes.

// What a worker runs: the server, the built web, the CLI and what installs its packages.
// Tests stay on the hub.
const BUNDLED = [
  "server",
  "shared",
  "scripts",
  "migrations",
  "dist",
  "bin",
  "package.json",
  "bun.lock",
  "tsconfig.json",
];
const isTest = (path: string) => path.endsWith(".test.ts");
// What decides the installed packages: a change there installs them before the next start.
const LOCKS = ["package.json", "bun.lock"];

const TAR =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "/usr/bin/tar";

function* files(root: string, rel: string): Generator<string> {
  const path = join(root, rel);
  if (!existsSync(path)) return;
  if (!statSync(path).isDirectory()) {
    if (!isTest(rel)) yield rel;
    return;
  }
  for (const name of readdirSync(path).sort()) yield* files(root, join(rel, name));
}

// The code's version: every bundled file's path, size and time. Cheap enough to read on each
// machine-list poll; the hub compares it with what the worker last received.
export function appVersion(root: string): string {
  const hash = createHash("sha256");
  for (const top of BUNDLED)
    for (const rel of files(root, top)) {
      const s = statSync(join(root, rel));
      hash.update(`${rel.replaceAll("\\", "/")}\0${s.size}\0${s.mtimeMs}\n`);
    }
  return hash.digest("hex").slice(0, 16);
}

// The bundle as gzipped tar bytes, built in `work` (emptied first).
// The assets `bun run refresh` carried over from earlier builds, so a page already open on the
// hub still loads its lazy chunks. A worker never needs them, and with several sessions
// refreshing they were more than half of dist/assets (22.5 of 40 MB on 2026-10-11).
export const CARRIED_ASSETS = "carried-assets.json";
function carriedAssets(root: string): string[] {
  try {
    const names = z
      .array(z.string().regex(/^[\w.-]+$/))
      .safeParse(JSON.parse(readFileSync(join(root, "dist", CARRIED_ASSETS), "utf8")));
    return names.success ? names.data : [];
  } catch {
    return [];
  }
}

export async function packBundle(root: string, work: string): Promise<Uint8Array> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const archive = join(work, "bundle.tgz");
  const present = BUNDLED.filter((p) => existsSync(join(root, p)));
  const skip = join(work, "exclude");
  const skipped = [`dist/${CARRIED_ASSETS}`, ...carriedAssets(root).map((n) => `dist/assets/${n}`)];
  writeFileSync(skip, `${skipped.join("\n")}\n`);
  const out = await run([TAR, "-czf", archive, "--exclude=*.test.ts", "-X", skip, ...present], {
    cwd: root,
    // macOS tar would add an AppleDouble `._` file beside every file with extended attributes.
    env: { COPYFILE_DISABLE: "1" },
    timeoutMs: 60_000,
  });
  if (out.code !== 0) throw new Error(`tar ha fallado: ${out.stderr.trim() || out.code}`);
  return Bun.file(archive).bytes();
}

// Pairing: the worker keeps only the token's hash, so its data folder never holds the token.
const PAIRING = "pairing.json";
const digest = (token: string) => createHash("sha256").update(token).digest();

export async function newPairing(dataDir: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const file = join(dataDir, PAIRING);
  writeFileSync(file, `${JSON.stringify({ sha256: digest(token).toString("hex") })}\n`, {
    mode: 0o600,
  });
  // Windows ignores the mode: the file inherits "Authenticated Users: modify" from the data
  // folder, so another local account could swap the hash. Only this user keeps access.
  if (process.platform === "win32") {
    const acl = await run(
      ["icacls", file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`],
      { env: process.env as Record<string, string>, timeoutMs: 10_000 },
    );
    if (acl.code !== 0) {
      rmSync(file, { force: true });
      throw Error(`icacls no ha podido proteger ${PAIRING}: ${acl.stderr.trim() || acl.code}`);
    }
  }
  return token;
}

// Whether `authorization` carries the paired token; false when this machine was never paired.
export function paired(dataDir: string, authorization: string | undefined): boolean {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!token) return false;
  let kept: Buffer;
  try {
    const { sha256 } = JSON.parse(readFileSync(join(dataDir, PAIRING), "utf8")) as {
      sha256?: unknown;
    };
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return false;
    kept = Buffer.from(sha256, "hex");
  } catch {
    return false;
  }
  return timingSafeEqual(kept, digest(token));
}

// What a worker reports as its code: the version it last received, or null before the first.
export const VERSION_FILE = "app-version";
export function receivedVersion(dataDir: string): string | null {
  try {
    return readFileSync(join(dataDir, VERSION_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export type ApplyDeps = {
  appRoot: string;
  dataDir: string;
  // Why the code in `root` would not start, or null.
  preflight: (root: string) => Promise<string | null>;
  log: (line: string) => void;
  // Whether the supervisor installs packages and rolls back (UPDATES_ENV). One started before
  // that code does neither, so the update keeps the old rules until `worker.ps1 start`.
  managed: boolean;
};

// Set by scripts/supervise.ts for its server: it runs beforeStart and afterExit.
export const UPDATES_ENV = "AOS_SUPERVISOR_UPDATES";

const same = (a: string, b: string) =>
  existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

// An update on trial: the app it replaced waits in PREV for TRIAL_MS from the first start.
// The supervisor, the one process that outlives the restart, reads these files: it installs
// the packages before a start, and puts PREV back after FAILURES error exits in the trial
// (one crash may be passing; the supervisor's backoff makes three take about 10 s).
const PREV = "app.prev";
const TRIAL = "update-trial.json";
const INSTALL = "install-pending";
export const TRIAL_MS = 2 * 60_000;
export const FAILURES = 3;
// A trial whose server never started (the restart was refused after the copy) is dropped.
const ABANDONED_MS = 5 * 60_000;
const Trial = z.object({
  packages: z.boolean(),
  appliedAt: z.number(),
  startedAt: z.number().optional(),
  failures: z.number().int().nonnegative().default(0),
});
type Trial = z.infer<typeof Trial>;

function readTrial(dataDir: string): Trial | null {
  try {
    return Trial.parse(JSON.parse(readFileSync(join(dataDir, TRIAL), "utf8")));
  } catch {
    return null;
  }
}
const writeTrial = (dataDir: string, trial: Trial) =>
  writeFileSync(join(dataDir, TRIAL), `${JSON.stringify(trial)}\n`);
const onTrial = (t: Trial | null, now: number) =>
  t !== null &&
  (t.startedAt === undefined ? now - t.appliedAt < ABANDONED_MS : now - t.startedAt < TRIAL_MS);

// Whether the next start installs packages first, so the restart has to stop the PTY host too.
export const installPending = (dataDir: string) => existsSync(join(dataDir, INSTALL));

let applying = false;

// Unpacks, checks and copies a bundle over the app; why it was refused, or null once the new
// code is in place (the caller restarts). Every refusal comes before the copy, so the app is
// left as it was.
// ponytail: a file the hub deleted stays on the worker; nothing loads files by listing a
// folder except migrations, which are never deleted. Prune against the bundle's list if a
// stale file ever gets loaded.
export async function applyBundle(bundle: Uint8Array, version: string, d: ApplyDeps) {
  if (applying) return "ya hay una actualización en marcha";
  if (onTrial(readTrial(d.dataDir), Date.now()))
    return "la actualización anterior aún está a prueba: espera un par de minutos";
  applying = true;
  try {
    const work = join(d.dataDir, "update");
    const staged = join(work, "app");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true });
    const archive = join(work, "bundle.tgz");
    writeFileSync(archive, bundle);
    const untar = await run([TAR, "-xzf", archive, "-C", staged], { env: {}, timeoutMs: 60_000 });
    if (untar.code !== 0)
      return `no se ha podido descomprimir: ${untar.stderr.trim() || untar.code}`;
    const problem = await d.preflight(staged);
    if (problem) return `el código nuevo no arrancaría: ${problem}`;
    const packages = LOCKS.some((f) => !same(join(staged, f), join(d.appRoot, f)));
    if (packages && !d.managed)
      return "cambian las dependencias (package.json o bun.lock) y el supervisor del worker es anterior a la instalación automática: ejecuta `worker.ps1 start` una vez en el PC y vuelve a actualizar";
    const prev = join(d.dataDir, PREV);
    rmSync(prev, { recursive: true, force: true });
    mkdirSync(prev, { recursive: true });
    for (const top of BUNDLED)
      if (existsSync(join(d.appRoot, top)))
        cpSync(join(d.appRoot, top), join(prev, top), { recursive: true });
    const before = join(d.dataDir, VERSION_FILE);
    if (existsSync(before)) cpSync(before, join(prev, VERSION_FILE));
    if (d.managed) writeTrial(d.dataDir, { packages, appliedAt: Date.now(), failures: 0 });
    if (packages) writeFileSync(join(d.dataDir, INSTALL), "");
    cpSync(staged, d.appRoot, { recursive: true, force: true });
    writeFileSync(join(d.dataDir, VERSION_FILE), `${version}\n`);
    d.log(`update: version ${version} in place${packages ? "; packages install on restart" : ""}`);
    return null;
  } finally {
    applying = false;
  }
}

export type StartDeps = {
  appRoot: string;
  dataDir: string;
  hostAlive: () => Promise<boolean>;
  install: () => Promise<{ code: number | null; stderr: string }>;
  log: (line: string) => void;
  now?: () => number;
};

// Before each start. Packages are installed only with no PTY host alive: on Windows it holds
// the native PTY module open. A failed install keeps the mark and the old packages, and the
// server starts anyway; new code that needs the packages dies early and is rolled back.
export async function beforeStart(d: StartDeps): Promise<void> {
  if (installPending(d.dataDir)) {
    if (await d.hostAlive()) d.log("update: packages wait until the PTY host stops");
    else {
      const out = await d.install();
      if (out.code === 0) {
        rmSync(join(d.dataDir, INSTALL), { force: true });
        d.log("update: packages installed");
      } else d.log(`update: bun install failed (${out.code}): ${out.stderr.trim().slice(-500)}`);
    }
  }
  const trial = readTrial(d.dataDir);
  if (trial && trial.startedAt === undefined)
    writeTrial(d.dataDir, { ...trial, startedAt: (d.now ?? Date.now)() });
}

// After each exit: the FAILURES-th error exit (not a clean stop, not a busy lock) inside the
// trial puts the previous app back; a clean stop or a trial that ran out keeps the update.
// The bundled paths are replaced, never overlaid, so files the update added go too. True on
// rollback.
export function afterExit(d: StartDeps, code: number | null): boolean {
  const trial = readTrial(d.dataDir);
  if (!trial || trial.startedAt === undefined) return false;
  if (code === LOCK_BUSY) return false;
  if (code === 0 || !onTrial(trial, (d.now ?? Date.now)())) {
    rmSync(join(d.dataDir, TRIAL), { force: true });
    return false;
  }
  const failures = trial.failures + 1;
  if (failures < FAILURES) {
    writeTrial(d.dataDir, { ...trial, failures });
    return false;
  }
  rmSync(join(d.dataDir, TRIAL), { force: true });
  const prev = join(d.dataDir, PREV);
  for (const top of BUNDLED) {
    rmSync(join(d.appRoot, top), { recursive: true, force: true });
    if (existsSync(join(prev, top)))
      cpSync(join(prev, top), join(d.appRoot, top), { recursive: true });
  }
  // No version before means the hub shows the worker behind, so it offers the update again.
  const version = join(prev, VERSION_FILE);
  if (existsSync(version)) cpSync(version, join(d.dataDir, VERSION_FILE));
  else rmSync(join(d.dataDir, VERSION_FILE), { force: true });
  if (trial.packages) writeFileSync(join(d.dataDir, INSTALL), "");
  d.log(
    `update: the new server failed ${failures} times (last exit ${code ?? "signal"}); previous app restored`,
  );
  return true;
}
