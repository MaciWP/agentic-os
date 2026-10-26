# Meeting transcripts

A helper app (`data/bin/AgenticAudio.app`) records a meeting's audio: the microphone and the
meeting app's sound as two tracks of 5-minute WAV chunks. The server transcribes the chunks as
they close and, when the recording stops, tells the speakers apart. Everything runs on this
Mac. Code: `server/features/transcripts/`; tables in `migrations/014_transcripts.sql`.

## How it flows

`recording → transcribing → diarizing → ready` (or `failed`, with the reason).

- **Capture.** `POST /api/transcripts/start` creates `data/transcripts/<id>/` and opens the
  helper; `POST /api/transcripts/:id/stop` writes `<id>/stop`. One recording at a time. Both
  tracks share one timeline: what a track misses (Teams not open yet, a rebuild, another output
  device) is written as zeros. The microphone is the raw device, so it records while Teams is
  muted.
- **Transcription.** For each closed chunk (`NNN.wav`; `.part` files are still being written),
  Silero VAD finds the speech, stretches under a second join a neighbour, and Parakeet (the
  dictation engine, shared) decodes each one. Parakeet is the dictation worker (two threads, shared queue, not
  niced). VAD and diarization run in a separate child under `nice -n 10`, two threads.
- **Speakers.** After the stop, the system track is split in blocks of 6 chunks (30 min): each
  is diarized by pyannote, a speaker with under 20 s of speech in the block joins the closest
  voice that talks longer (the clustering leaves dozens of such crumbs), and the rest are linked
  to the earlier blocks' by voice embedding. `speakers` in the start body fixes the count (the closest voices merge down to
  it). The microphone is always `me`.
- **Restart.** The poll reads the database and the folder: whatever is unfinished goes on.
- **Output.** `GET /api/transcripts/:id` gives `segments` (`{start, end, speaker, text}`),
  `markdown` (`[hh:mm:ss] Speaker: text`), `progress` (chunks done of those closed) and, while
  recording, the helper's `warnings`. Before the diarization the system track reads as
  `others`. `PUT /api/transcripts/:id/speakers` with
  `{"names": {"Speaker 1": "Ana", "me": "Oriol"}}` renames; the transcript is built on read.

## Calls start and stop it

The server polls `AgenticAudio probe` (a direct run, 0.1 s) on each tick. When the meeting app
(`bundle`) holds the microphone for 5 s and no recording runs or started during that call, it
starts one; when the app lets go for 10 s, it stops the one running since before (two meetings back to back leave it free for under a minute, so a longer wait joins them). Each change is logged (`call: microphone taken|released`). A recording
is linked to the calendar meeting that overlaps its start (at most 10 minutes early), now or
when a later sync brings it. Every recording, by hand or by a call, gets a tile `rec:<id>` in
the Mesa «Reuniones» of the «Sistema» block.

## After the text is ready

- The chunks' WAV files are deleted: only the text, the turns and `state.json` stay. The one
  exception is for tuning the diarization: an empty `data/transcripts/keep-audio` keeps the
  audio of the next call that lasts 20 minutes or more, once (the file moves into that
  recording's folder). Delete those WAVs by hand when the tuning is done.
- A review agent starts on its own (see ADR 0002, amendment 2026-10-22): it proposes
  decisions, actions and things to remember (`proposals.json`). In the tile the user accepts
  (an action becomes a task with `source` `recording:<id>`; a decision goes under
  `## Acuerdos` and a memory under `## Para recordar` of the meeting's note, or of a note
  `Llamada YYYY-MM-DD HHMM` when there is no meeting) or discards each one (`review.json`).
  An edited text is saved as edited. A new proposal keeps the decisions on the items it repeats.
- Routes: `GET|POST /api/transcripts/:id/proposals`, `POST /api/transcripts/:id/proposals/:item`
  (`{"state":"accepted"|"discarded","text"?}`, refused when sent by an agent),
  `POST /api/transcripts/:id/review` (another run).

## Install the models

About 35 MB, once, next to the dictation model (see [voice.md](voice.md)):

```sh
cd data/models
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
curl -LO $B/asr-models/silero_vad.onnx
curl -LO $B/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx
curl -L $B/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | tar xj
```

## Configure

In `data/config.json` (absolute paths; `voice.model` must be set too):

```json
"transcripts": {
  "vad": "/abs/data/models/silero_vad.onnx",
  "segmentation": "/abs/data/models/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx",
  "embedding": "/abs/data/models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx",
  "bundle": "com.microsoft.teams2"
}
```

## Check it on real speech

```sh
TRANSCRIPTS_REAL=1 bun test server/features/transcripts/integration.test.ts
```

Builds a two-voice conversation with macOS `say`, runs the whole pipeline (two diarization
blocks) and prints the transcript. Skipped otherwise.

To tune the diarization on kept audio, run the worker on the recording's system chunks with
`tuning` (any of `threshold`, sherpa's clustering distance, smaller gives more speakers;
`sameVoice`, the cosine that links blocks; `minVoiceSeconds`):

```sh
bun server/features/transcripts/worker.ts diarize '{"files":[{"path":".../system/000.wav","offset":0}],
  "segmentation":"...","embedding":"...","speakers":null,"blockChunks":6,"tuning":{"threshold":0.8}}'
```
