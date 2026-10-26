# Voice dictation

Hold **⌃⌘** in a terminal tile, speak, release. The text appears at the prompt as if
pasted; nothing is sent until you press Enter. **Esc** while holding cancels. The
microphone button in the tile header does the same with two clicks. Once released, you can go
to another Mesa or page: the text still lands in that terminal. Leaving while you still speak
drops the recording.

Everything runs on this Mac: no account, no network, no audio kept. Design and trade-offs:
[ADR 0011](adr/0011-voice.md).

## Install the model

About 640 MB, once:

```sh
mkdir -p data/models && cd data/models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
tar xjf sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 && rm sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
```

## Configure

In `data/config.json` (the path must be absolute):

```json
"voice": {
  "model": "/absolute/path/to/data/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  "idleMinutes": 10,
  "replace": { "use query": "useQuery", "biem": "Biome" },
  "terms": ["Poneglyph", "Biome", "TanStack"],
  "boost": 0,
  "warmSeconds": 30,
  "browserProcessing": true,
  "evalCapture": false
}
```

- `model` turns dictation on. The server checks at startup that the folder has `tokens.txt`.
  To try Canary or Qwen3-ASR instead, unpack it next to Parakeet and point `model` at its
  folder; switch back the same way. Both need a server restart:

  ```sh
  cd data/models
  curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2
  tar xjf sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2 && rm sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2
  # Qwen3-ASR 0.6B (about 840 MB): reads the glossary as context, about 4x slower than Parakeet
  curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2
  ```
- `idleMinutes` (default 10): the model is unloaded after this long without dictating.
- `replace`: what the model hears → what you meant. Whole words, any case. Add an entry
  each time a name comes out wrong. Jira keys of `jira.project` are joined on their own.
- `terms`: words the model should expect, written as you want them. They join the targets of
  `replace` and the Jira key in one glossary that Parakeet leans towards while it decodes
  (tens of ms more per dictation). A term only helps when its spelling sounds like what you
  say, and a strong pull also bends nearby words.
- `boost` (default 0, off): how hard the glossary pulls. On a synthetic phrase 5 turned
  "pasa bien" into "pasa Biome" but also "pone glip y" into "con C". Turn it on only with
  the value the test set picks.
- `warmSeconds` (default 30): the microphone stays open this long after a dictation, so the
  next one hears from the first moment. A USB headset took about 280 ms to open; a word said in
  that time was lost. 0 opens it only while recording. The pill says "Abriendo el micro…" until
  the first sound arrives: start speaking when it says "Escuchando".
- `browserProcessing` (default true): the browser's echo cancellation, noise suppression and
  gain control. With a headset there is no echo to cancel; try `false` with the test set.
- `evalCapture` (default false): keeps every dictation in `data/voice-eval/` (a WAV and what the
  model heard) to measure changes on your own voice. Turn it off once the set is big enough.

Restart the server after changing it. The first dictation after a pause loads the model
(about 2.5 s), and it starts loading as soon as you begin to speak.

## Measure on your own voice

With `evalCapture` on, dictate as usual for a while (30 dictations are enough), then:

```sh
bun scripts/voice-bench.ts   # first run writes data/voice-eval/refs.tsv
# correct each line of refs.tsv to what you actually said, then
bun scripts/voice-bench.ts
```

It prints, per setting (no glossary, glossary at 3, 5 and 8, and every other model installed
next to the configured one), the word error rate, the glossary terms said and written right,
the terms written but never said, and the decode time per second of audio. Synthetic voices
(`say`) do not measure this: they garble English words the way no person does.

## When it does not work

The tile shows the reason as a notice. If the browser has no microphone permission, allow
it for the app's address in the browser and, on macOS, under System Settings → Privacy &
Security → Microphone. "No se ha oído nada" means the recording was silent: check the input
device.

Every dictation leaves one line in the server log (`data/server.log` when started with
`start-agentic-os.command`), never what was said:

```text
2026-10-08T09:12:03.120Z INFO voice: 6.5 s audio, 269 ms
2026-10-08T09:12:03.410Z INFO voice: done 8.9 s, mic 81 ms, 357 ms after release
2026-10-08T09:14:40.002Z INFO voice: cancelled 6.9 s
```

`done` lines give how long the microphone took to start, which device it was, and the wait
after you release the keys; `failed`, `silent`, `too_short` and
`mic_error` lines say what went wrong.
