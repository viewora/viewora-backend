-- Migration: hotspots on car exterior photos
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-vehicle-hotspots.down.sql
-- Requires migration-vehicle-views.sql to have run first.
--
-- Purely additive: one new table. A hotspot is a pin on one exterior photo;
-- x / y are fractions (0-1) of the photo's width / height, so pins survive the
-- image being resized or shown at any screen size.

CREATE TABLE IF NOT EXISTS vehicle_hotspots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id UUID NOT NULL REFERENCES vehicle_views(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'feature' CHECK (kind IN ('feature', 'damage', 'info', 'link')),
  x REAL NOT NULL CHECK (x >= 0 AND x <= 1),
  y REAL NOT NULL CHECK (y >= 0 AND y <= 1),
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_hotspots_view_id_idx ON vehicle_hotspots (view_id);
CREATE INDEX IF NOT EXISTS vehicle_hotspots_space_id_idx ON vehicle_hotspots (space_id);

-- Only the backend (service key) reads/writes this table.
ALTER TABLE vehicle_hotspots ENABLE ROW LEVEL SECURITY;

-- Make the new table visible to the API straight away (otherwise the API can
-- answer "table not found" until its schema cache refreshes).
NOTIFY pgrst, 'reload schema';
