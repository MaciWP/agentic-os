-- Meeting recordings and their transcripts (server/features/transcripts). The audio stays in
-- `dir` as 5-minute WAV chunks per track; the rows here say how far each one got, so a restart
-- picks the work up where it stopped.

-- status: recording → transcribing → diarizing → ready, or failed. `speakers` is the number the
-- user said were talking (NULL: guess); `speaker_names` maps «Speaker 1» to a name; `diarization`
-- holds the system track's speaker turns once known.
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recording', 'transcribing', 'diarizing', 'ready', 'failed')),
  speakers INTEGER CHECK (speakers IS NULL OR speakers BETWEEN 1 AND 20),
  speaker_names TEXT NOT NULL DEFAULT '{}',
  diarization TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX recordings_meeting ON recordings (meeting_id);

-- One closed chunk file. `offset_sec` is where it starts in the recording; `text` is the JSON
-- list of {start, end, text} (absolute seconds) once it is done.
CREATE TABLE recording_chunks (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  track TEXT NOT NULL CHECK (track IN ('mic', 'system')),
  idx INTEGER NOT NULL,
  offset_sec REAL NOT NULL,
  duration_sec REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  text TEXT,
  PRIMARY KEY (recording_id, track, idx)
);
