-- Migration: several spins per car (roof up / roof down, doors open, night...)
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-vehicle-spins.down.sql
-- Requires migration-vehicle-views.sql (and migration-vehicle-hotspots.sql) to have run first.
--
-- Additive. A spin is one walk around the car. Every existing car gets one spin
-- called "Exterior" holding the photos it already has, so nothing changes for
-- buyers until the owner adds a second spin.

CREATE TABLE IF NOT EXISTS vehicle_spins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Exterior',
  -- The frame buyers see first, as degrees around the car (0 = front).
  start_angle SMALLINT NOT NULL DEFAULT 0 CHECK (start_angle >= 0 AND start_angle < 360),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_spins_space_id_idx ON vehicle_spins (space_id, order_index);

-- Only the backend (service key) reads/writes this table.
ALTER TABLE vehicle_spins ENABLE ROW LEVEL SECURITY;

ALTER TABLE vehicle_views ADD COLUMN IF NOT EXISTS spin_id UUID REFERENCES vehicle_spins(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS vehicle_views_spin_id_idx ON vehicle_views (spin_id);

-- One "Exterior" spin for every car that already has photos and no spin yet.
INSERT INTO vehicle_spins (space_id, title, order_index)
SELECT DISTINCT v.space_id, 'Exterior', 0
FROM vehicle_views v
WHERE v.spin_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM vehicle_spins s WHERE s.space_id = v.space_id);

-- Put those photos in it (the first spin of their car).
UPDATE vehicle_views v
SET spin_id = (
  SELECT s.id FROM vehicle_spins s
  WHERE s.space_id = v.space_id
  ORDER BY s.order_index, s.created_at
  LIMIT 1
)
WHERE v.spin_id IS NULL;

-- Make the changes visible to the API straight away.
NOTIFY pgrst, 'reload schema';
