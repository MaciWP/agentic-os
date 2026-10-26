# ADR 0011 — Voice dictation

Status: implemented and verified with a synthetic voice; real-voice check pending (2026-10-07).
Glossary, warm microphone and test set added 2026-10-13.

## Decision

Dictate into a terminal by holding ⌃⌘ in its tile. The browser records, a local model
on this Mac transcribes, and the terminal pastes the text as ⌘V would: no Enter, ever.
The same path works for Claude, Codex, Grok and a plain shell, because the text arrives
as a paste and no harness is asked for anything.

- **Engine:** NVIDIA Parakeet TDT 0.6B v3, int8, through `sherpa-onnx-node`. CPU only,
  multilingual with Spanish among its strongest languages, CC-BY-4.0, about 640 MB on
  disk. Measured on the M3: about 2.5 s to load, then about 0.2 s for 4 s of speech.
- **Process:** a worker child of the server (`server/features/voice/worker.ts`), JSON
  lines over stdin/stdout. It starts on the first dictation, and `POST /api/voice/warm`
  starts it as recording begins, so loading overlaps with speaking. It exits after
  `voice.idleMinutes` without use, when the server stops, or when its stdin closes. No
  RAM is held while no one dictates (about 1.2 GB while it is loaded). One transcription
  runs at a time; the rest wait in order.
- **Capture:** `getUserMedia` (the browser's echo cancellation, noise suppression and gain
  control unless `voice.browserProcessing` is false), an `AudioContext` at 16 kHz and an
  AudioWorklet that collects PCM16. At most 120 s per dictation. The microphone stays open
  `voice.warmSeconds` (default 30) after a dictation, recording nothing, and closes after.
  Opening it each time cost about 280 ms on a USB headset (35 ms on the built-in one), and a
  word said in that time was lost; half the dictations come within 30 s of the one before,
  18 % within 5 s. As in Handy, which also keeps its stream 30 s. The pill says "Abriendo el
  micro…" until the first sound arrives. No pre-roll is prepended: audio without speech before
  a short phrase is what turned "sí, hazlo" English.
- **One pass:** the whole recording is transcribed at once when the keys are released, as
  push-to-talk dictation apps on the same model do (Handy). Decoding takes about 50 ms per
  second of speech on the M3, so 30 s wait about 1.5 s. The audio graph (context and
  worklet) is built when a terminal opens and kept suspended between dictations, and the
  microphone opens in parallel with it: rebuilt each time, the first sound came about
  0.5 s after the keys, and a quick "sí, hazlo" lost its "sí" (a 150 ms cut turns it into
  "Hazlo" or "Had lo"). The browser reports that delay with each dictation.
- **Delivery:** `term.paste(text + " ")` in the focused tile. Bracketed paste applies when
  the program asked for it. The server's terminal code is unchanged.
- **Glossary:** `voice.terms`, the targets of `voice.replace` and the Jira key are boosted
  while Parakeet decodes: sherpa-onnx takes hotwords only with `modified_beam_search` and only
  as the model's own tokens, and ships no tokenizer for Parakeet, so `pieces.ts` splits each
  term into the longest pieces of `tokens.txt`. On one synthetic phrase (`say`, so not a
  measure of accuracy) boost 5 turned "pasa bien" into "pasa Biome" but also "pone glip y"
  into "con C", and left "Usequerien"; 1.5 and 3 changed nothing. It is off by default
  (`voice.boost` 0) until the test set picks a value.
- **Normalization:** after decoding, `voice.replace` maps what is heard to what is meant, whole words and case
  insensitive, longest first. The configured Jira project's key is joined to its number
  (`ABC 12` → `ABC-12`). Spanish numbers the model spells out become digits
  ("mil setenta y siete" → 1077, so the key is found); "un", "una" and "uno" alone stay
  words. The output is always one line: a newline typed into an agent
  would send the prompt.

## Keys

The microphone opens as ⌃⌘ go down, so the first word is not lost while it starts. Released
within 200 ms, or with another key in between, it was a tap or a ⌃⌘ shortcut: the recording is
dropped and the key goes through. After that, releasing either key stops and transcribes, and Esc
cancels. While recording, no key reaches the terminal. While a dictation records or waits for its
text, Esc is the dictation's alone: in Claude an Esc interrupts the turn. Losing the window
cancels a hold, since its keyup would never arrive. A microphone button in the tile header
does the same with clicks.

While it records, a pill at the top of the terminal, clear of the prompt, shows a live level meter and the time, and a red
ring marks the tile; while it transcribes, the pill says so. Both appear after 150 ms, so a
⌃⌘ shortcut never flashes them.

Once released, a dictation belongs to its terminal, not to the tile that recorded it. The wait
lives in the page (`web/features/voice/pending.ts`) and the text is pasted through
`POST /api/terminals/:id/send`, so it lands even if the user moved to another Mesa, Agentes or
Consumo meanwhile; that terminal's tile, shown again, shows the wait and Esc still drops it. A
failure shows in the next view of that terminal. Leaving a tile while it still records drops
the recording and frees the microphone. A reload drops a wait, since the browser cancels the
request.

⌃⌘ was chosen over ⌃⌥: the user finds it easier to hold. Held alone it triggers nothing in
macOS, the browser or the app. With a letter it can: ⌃⌘Q locks the screen, ⌃⌘F toggles full
screen, ⌃⌘Space opens the emoji picker; the system takes those before the page sees them.
⌥ alone was rejected: on a Spanish Mac keyboard it types @, #, | and \ and jumps by word.

## Privacy and trust

Audio and text never leave the Mac and are never logged; they are stored only while the user turns on `voice.evalCapture` (see Test set). The server logs one line
per decode (`voice: 6.5 s audio, 269 ms`) and one per dictation with how it ended, which the
browser reports to `POST /api/voice/report`: `done` with the microphone's start delay and the
wait after the release, `too_short`, `silent`, `mic_error`, `failed` with the error, or `cancelled` (holds
under 0.5 s are taps and are not reported). The report schema is strict and carries no text.
A failed decode also logs `voice: failed on 6.5 s audio: <error>`. The route is JSON (base64 PCM) behind `localGuard`,
with a body limit sized to 120 s. The worker opens no port. Recordings under 0.15 s and
silent ones stop in the browser with a notice and never reach the server. Short words are
sent as recorded: padding them with silence made the model switch to English.

## Second model

Canary 180M Flash (sherpa-onnx `nemo-canary-180m-flash-en-es-de-fr-int8`, about 210 MB) can
replace Parakeet by pointing `voice.model` at its folder; the worker tells them apart by
their files and fixes Canary's language to Spanish, which Parakeet guesses. Both stay
installed, and the server log names the model at startup. Measured on synthetic Spanish
clips (macOS `say`), Parakeet was ahead on every clip, short ones included ("Sí, hazlo." vs
"sí, aló.") and on identifiers, and loads in 1.2 s at 1.1 GB against 0.6 s at 0.45 GB. It
stays the default; Canary is kept to compare on the user's real voice, where short
dictations came back in English with Parakeet.

## Test set

Accuracy is measured on the user's own voice, never on `say` clips. With `voice.evalCapture`
on, each dictation is written to `data/voice-eval/` (a WAV and what the model heard; outside
git, never logged), the user corrects `refs.tsv`, and `scripts/voice-bench.ts` compares word
error rate, glossary recall, invented terms and decode time per setting and installed model.
It is off by default and meant to be turned off once the set is big enough.

## Qwen3-ASR

`sherpa-onnx-node` 1.13.8 loads Qwen3-ASR (Apache 2.0, January 2026), which reads a glossary
as context in its prompt, and the worker takes it like Canary, told apart by
`conv_frontend.onnx`. The 0.6B int8 export (the only one for sherpa) was about 4x slower than
Parakeet (720 ms against 180 ms for 4 s) and wrong on its own Spanish sample clip ("menor al
habitual"); with the glossary it wrote "Poneglyph" but not "useQuery" or "Biome". It stays a
candidate for the test set, not the default. The 1.7B model (FLEURS-es 3.36 % WER against
4.94 %) has no sherpa export; it would need a Python MLX sidecar.

## Rejected

- `sherpa-onnx-offline-websocket-server`: it opens a TCP port.
- Running the sherpa CLI once per dictation: it would load 640 MB every time.
- Whisper-family models: slower on CPU at a comparable size, and known to invent text
  on silence.
- Cloud speech APIs: cost, and audio leaving the Mac.
- Cutting the recording at pauses and pasting phrase by phrase while the user speaks, as
  sherpa-onnx simulates streaming with an offline model. Tried on the user's voice: cuts
  split phrases ("que se cierra" came back "que sea Se cierra"), each part ended as its own
  sentence, and short parts lost the model's context. Decoding the whole is more accurate
  and fast enough.
- An LLM cleanup pass: more latency and cost for a prompt the agent reads anyway.
- Typing through `/bring` or the PTY: a paste already does the right thing in every
  harness, and dictating into an unfocused tile was not needed.

## Verification

Unit tests cover the worker lifecycle (on-demand start, idle exit, queue, crashes,
timeouts), the route (validation, limits, unconfigured, logs without text, reports), normalization,
the key state machine and where a recording is cut. `e2e/voice.e2e.ts` runs Chromium with a fake microphone that
plays a phrase generated with macOS `say`: holding ⌃⌘ puts the transcript at a shell's
prompt without running it, a 9 s hold is sent as one request after the release, Esc
after a long hold pastes nothing, and Esc mid-hold sends nothing. It skips when `voice.model` is
not configured. Accuracy on the user's own voice and microphone is checked by hand.

Deferred: dictation in the palette and notes (the hook is reusable), dictating into an
unfocused tile, and Windows.
