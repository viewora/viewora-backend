-- Migration: Object Spotlights (HUD callouts on objects in a scene) + Spotlight Studio keys.
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-spotlights.down.sql
--
-- Purely additive: three new tables. Tours without spotlights are unaffected,
-- and until this has run the tour simply has no spotlights (routes/public.ts
-- skips the lookup when the table is missing).
--
-- scene_spotlights: one row per object. `data` is what the tour draws
--   { label, yaw, pitch, zoom, polygon: [[yaw, pitch], ...], title, lines: [...], hint?, model? }
--   (radians, PSV's convention; validated by SpotlightData in utils/spotlights.ts).
--   `source` is Spotlight Studio's working notes (where it was clicked, in degrees),
--   so it can be edited again from any computer. Never sent to visitors.
-- scene_spotlight_files: per scene, the published file the tour fetches when the
--   scene opens (all of its objects in one small JSON on the media domain,
--   content-hashed name, cached for a year). Rewritten on every change.
-- studio_keys: "Connected apps". A key lets Spotlight Studio on one computer
--   publish spotlights to its owner's tours, and nothing else. Only its SHA-256
--   is stored. Revoked or expired keys stop working at once.

CREATE TABLE IF NOT EXISTS scene_spotlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL CHECK (object_key ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  data JSONB NOT NULL,
  voice_url TEXT,
  source JSONB,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scene_id, object_key)
);
CREATE INDEX IF NOT EXISTS scene_spotlights_space_id_idx ON scene_spotlights (space_id);

CREATE TABLE IF NOT EXISTS scene_spotlight_files (
  scene_id UUID PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  object_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scene_spotlight_files_space_id_idx ON scene_spotlight_files (space_id);

CREATE TABLE IF NOT EXISTS studio_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Spotlight Studio',
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS studio_keys_user_id_idx ON studio_keys (user_id);

-- Only the backend (service key) reads/writes these tables.
ALTER TABLE scene_spotlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE scene_spotlight_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_keys ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
