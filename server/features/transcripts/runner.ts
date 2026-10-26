import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { CALL_TIMING, CallWatcher } from "./calls.ts";
import { type Chunk, chunkPath, closedChunks } from "./chunks.ts";
import { HelperState, type Range, SAMPLE_RATE, type Turn, type Words } from "./contracts.ts";
import { markdown, mergeTracks, speakerLabel } from "./merge.ts";
import { decodePlan } from "./plan.ts";
import { type Recording, TranscriptError, type TranscriptStore } from "./store.ts";
import { readPcm, wavInfo } from "./wav.ts";

// The slow parts and the outside world, so a test runs the whole flow without any of them.
export type Ports = {
  // Parakeet on one clip of base64 PCM16.
  decode: (pcmBase64: string) => Promise<string>;
  vad: (wav: string) => Promise<Range[]>;
  diarize: (files: { path: string; offset: number }[], speakers: number | null) => Promise<Turn[]>;
  alive: (pid: number) => boolean;
  // Runs a command, answers its exit code.
  launch: (argv: string[]) => Promise<number>;
  // Whether the meeting app holds the microphone now (calls.ts); absent, nothing starts alone.
  inCall?: () => Promise<boolean>;
};

export type Settings = {
  // data/transcripts: one folder per recording.
  root: string;
  // The capture helper (an .app) and the app whose audio it takes.
  app: string;
  bundle: string;
  // Why nothing can be recorded here (a model or the helper is missing), or null.
  missing: () => string | null;
  pollMs: number;
  // How long a recording may go without the helper's first state.json.
  graceMs: number;
  now: () => number;
  id: () => string;
  // How long a call must last for the keep-audio file to keep its audio (KEEP_AUDIO).
  keepAudioMinSeconds?: number;
};

const logger = log("transcripts");

// Diarization tuning (docs/transcripts.md): this file in the root keeps the audio of the next
// call that lasts long enough, once; the file moves into that recording's folder. Shorter
// calls lose their audio as always.
export const KEEP_AUDIO = "keep-audio";
const KEEP_AUDIO_MIN_SECONDS = 20 * 60;

export const readState = (dir: string): HelperState | null => {
  try {
    return HelperState.parse(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")));
  } catch {
    return null;
  }
};

// Recordings from capture to transcript. Everything advances in `poll()`, one recording and one
// slow step at a time, so the speech models never run on more than their two threads; what a
// restart needs is already in the database and on disk, so there is no separate resume.
export class Transcripts {
  private inflight: Promise<void> | null = null;
  private readonly readyListeners = new Set<(rec: Recording) => void>();
  private readonly startListeners = new Set<(rec: Recording) => void>();

  constructor(
    private readonly store: TranscriptStore,
    private readonly ports: Ports,
    private readonly settings: Settings,
  ) {}

  async start(input: { meetingId?: number; speakers?: number }): Promise<Recording> {
    const why = this.settings.missing();
    if (why) throw new TranscriptError(409, "not_configured", why);
    if (this.store.list().some((r) => r.status === "recording"))
      throw new TranscriptError(409, "busy", "a recording is already running");
    const id = this.settings.id();
    const dir = join(this.settings.root, id);
    const rec = this.store.create({ id, dir, ...input });
    mkdirSync(dir, { recursive: true });
    const code = await this.ports.launch([
      "open",
      "-n",
      "-g",
      this.settings.app,
      "--args",
      "record",
      "--dir",
      dir,
      "--bundle",
      this.settings.bundle,
    ]);
    if (code !== 0) {
      this.store.setStatus(id, "failed", `could not open the capture helper (exit ${code})`);
      return this.store.get(id);
    }
    for (const listener of this.startListeners) listener(rec);
    return rec;
  }

  // Told when a recording starts, by hand or because a call began.
  onStart(listener: (rec: Recording) => void): () => void {
    this.startListeners.add(listener);
    return () => this.startListeners.delete(listener);
  }

  // Told once per recording, when its transcript is ready.
  onReady(listener: (rec: Recording) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  get(id: string): Recording {
    return this.store.get(id);
  }

  stop(id: string): Recording {
    const rec = this.store.get(id);
    if (rec.status !== "recording")
      throw new TranscriptError(409, "not_recording", "the recording is not running");
    writeFileSync(join(rec.dir, "stop"), "");
    return rec;
  }

  setNames(id: string, names: Record<string, string>) {
    this.store.setNames(id, names);
  }

  list() {
    return this.store.list().map(summary);
  }

  detail(id: string) {
    const rec = this.store.get(id);
    const mic = this.store.words(id, "mic");
    const system = this.store.words(id, "system");
    // Before the diarization the text so far shows, the system track as one "others".
    const segments = mergeTracks(mic, system, rec.turns, rec.names);
    const labels = [
      ...(mic.length > 0 ? ["me"] : []),
      ...[...new Set((rec.turns ?? []).map((t) => t.speaker))].sort().map(speakerLabel),
    ];
    const warnings = rec.status === "recording" ? (readState(rec.dir)?.warnings ?? []) : [];
    return {
      ...summary(rec),
      names: rec.names,
      labels,
      progress: this.store.progress(id),
      warnings,
      segments,
      markdown: markdown(segments),
    };
  }

  // The timer of the real server; it also polls at once, which is the resume after a restart.
  // Each tick also looks for a call to record or to stop.
  watch(): () => void {
    const calls = this.callWatcher();
    const tick = () => {
      void this.poll();
      void calls
        ?.tick(this.settings.now())
        .catch((err) => logger.error(`call check failed: ${errorMessage(err)}`));
    };
    tick();
    const timer = setInterval(tick, this.settings.pollMs);
    return () => clearInterval(timer);
  }

  private callWatcher(): CallWatcher | null {
    const inCall = this.ports.inCall;
    if (!inCall || this.settings.missing()) return null;
    const running = () => this.store.list().find((r) => r.status === "recording") ?? null;
    return new CallWatcher(
      {
        inCall,
        running,
        recordedSince: (at) => this.store.list().some((r) => Date.parse(r.createdAt) >= at),
        start: async () => {
          const rec = await this.start({});
          logger.info(`call detected: recording ${rec.id}`);
        },
        stop: (id) => {
          this.stop(id);
          logger.info(`call ended: recording ${id} stopped`);
        },
        log: (line) => logger.info(line),
      },
      CALL_TIMING,
    );
  }

  // One pass over the unfinished recordings. Calls that overlap share the running pass.
  poll(): Promise<void> {
    this.inflight ??= this.sweep().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async sweep() {
    this.store.linkMeetings();
    for (const rec of this.store.unfinished()) {
      try {
        await this.step(rec);
      } catch (err) {
        logger.error(`recording ${rec.id} failed: ${errorMessage(err)}`);
        this.store.setStatus(rec.id, "failed", errorMessage(err));
      }
    }
  }

  private async step(rec: Recording) {
    let status = rec.status;
    if (status === "recording") {
      const state = readState(rec.dir);
      if (state?.status === "failed") {
        this.store.setStatus(rec.id, "failed", state.error ?? "the capture helper failed");
        return;
      }
      if (!state) {
        if (this.settings.now() - Date.parse(rec.createdAt) > this.settings.graceMs) {
          // A helper that starts after all would record for nobody: the stop file ends it.
          writeFileSync(join(rec.dir, "stop"), "");
          this.store.setStatus(rec.id, "failed", "the capture helper did not start");
        }
        return;
      }
      const ended =
        state.status === "stopped" || (state.pid != null && !this.ports.alive(state.pid));
      await this.transcribePending(rec);
      if (!ended) return;
      status = "transcribing";
      this.store.setStatus(rec.id, status);
    }
    if (status === "transcribing") {
      await this.transcribePending(rec);
      if (this.store.chunkCount(rec.id, "system") === 0) {
        this.ready(rec);
        return;
      }
      status = "diarizing";
      this.store.setStatus(rec.id, status);
    }
    if (status === "diarizing") {
      const chunks = await closedChunks(rec.dir, "system");
      const files = chunks.map((c) => ({
        path: chunkPath(rec.dir, "system", c.idx),
        offset: c.offset,
      }));
      this.store.setTurns(rec.id, await this.ports.diarize(files, rec.speakers));
      this.ready(rec);
    }
  }

  // Only the text is kept (the user's choice): the audio goes once it is transcribed. A failed
  // recording keeps it, and so does one the user kept for tuning (KEEP_AUDIO).
  private ready(rec: Recording) {
    this.store.setStatus(rec.id, "ready");
    const done = this.store.get(rec.id);
    for (const listener of this.readyListeners) listener(done);
    const keep = join(this.settings.root, KEEP_AUDIO);
    const min = this.settings.keepAudioMinSeconds ?? KEEP_AUDIO_MIN_SECONDS;
    if (existsSync(keep) && this.store.length(rec.id) >= min) {
      renameSync(keep, join(rec.dir, KEEP_AUDIO));
      logger.info(`recording ${rec.id}: audio kept for diarization tuning`);
      return;
    }
    for (const track of ["mic", "system"].map((t) => join(rec.dir, t)).filter(existsSync))
      for (const name of readdirSync(track, { withFileTypes: true }))
        if (name.isFile() && /\.wav(\.part)?$/.test(name.name))
          rmSync(join(track, name.name), { force: true });
  }

  // The closed chunks not yet known are recorded, then every pending one is transcribed.
  private async transcribePending(rec: Recording) {
    const found = [
      ...(await closedChunks(rec.dir, "mic")),
      ...(await closedChunks(rec.dir, "system")),
    ];
    this.store.addChunks(rec.id, found);
    for (const row of this.store.pending(rec.id)) {
      const words = await this.transcribeChunk(rec.dir, row);
      this.store.markDone(rec.id, row.track, row.idx, words);
    }
  }

  // Speech by the VAD, the stretches too short for the model merged or widened, each decoded in
  // turn; times are in the recording, not the chunk.
  private async transcribeChunk(dir: string, chunk: Chunk): Promise<Words[]> {
    const path = chunkPath(dir, chunk.track, chunk.idx);
    const wav = await wavInfo(path);
    const plan = decodePlan(await this.ports.vad(path), wav.samples / SAMPLE_RATE);
    const words: Words[] = [];
    for (const range of plan) {
      const from = Math.floor(range.start * SAMPLE_RATE);
      const pcm = await readPcm(
        path,
        wav,
        from,
        Math.ceil((range.end - range.start) * SAMPLE_RATE),
      );
      const text = (await this.ports.decode(Buffer.from(pcm).toString("base64"))).trim();
      if (text)
        words.push({ start: chunk.offset + range.start, end: chunk.offset + range.end, text });
    }
    return words;
  }
}

const summary = (r: Recording) => ({
  id: r.id,
  meetingId: r.meetingId,
  status: r.status,
  speakers: r.speakers,
  error: r.error,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
