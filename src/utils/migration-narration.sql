-- Migration: recorded narration for patient journeys (Kokoro TTS worker).
-- Run in Supabase Dashboard > SQL Editor > New query, AFTER migration-journeys.sql.
-- Rollback: migration-narration.down.sql
--
-- Purely additive. Journeys without recordings keep working (captions only).
--
-- Every line of a journey ("What happens here?") gets its own short recording.
-- A recording is found by a hash of what was said and how:
--   sha256("kokoro-82m-v1.0\n<voice>\n1.0\n<line, trimmed, spaces collapsed>")
-- (src/utils/narration.ts and tts-worker/narration.py compute the same hash).
-- So an unchanged line is never recorded twice, the same sentence in two
-- journeys shares one file, and editing a line simply makes it "need a voice".

CREATE TABLE IF NOT EXISTS narration_audio (
  hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  voice TEXT NOT NULL,
  model TEXT NOT NULL,
  -- Word timings when the TTS model gives them: [{ w, s, e }] in ms. Optional.
  words JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The to-do list the worker clears. "Generate voice" adds one job per journey;
-- the worker records every line still missing, then marks the job done.
CREATE TABLE IF NOT EXISTS narration_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  voice TEXT NOT NULL DEFAULT 'af_heart',
  force BOOLEAN NOT NULL DEFAULT false,
  total INTEGER NOT NULL DEFAULT 0,
  done_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS narration_jobs_status_idx ON narration_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS narration_jobs_journey_idx ON narration_jobs (journey_id, created_at DESC);

-- Which voice a journey is read in (Kokoro voice id).
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS narration_voice TEXT NOT NULL DEFAULT 'af_heart';

-- Only the backend and the worker (service key) read/write these.
ALTER TABLE narration_audio ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_jobs ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
