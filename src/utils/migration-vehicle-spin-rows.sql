-- Migration: spins at several camera heights (a "2D grid" spin)
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-vehicle-spin-rows.down.sql
-- Requires migration-vehicle-spins.sql.
--
-- Additive. A row is one more walk around the car with the camera higher (or lower)
-- than its main spin. Buyers drag up and down to change height, at the same angle.
-- row_of points at the main spin; elevation is the camera height in degrees
-- (0 = eye level, positive = higher, negative = lower).

ALTER TABLE vehicle_spins ADD COLUMN IF NOT EXISTS row_of UUID REFERENCES vehicle_spins(id) ON DELETE CASCADE;
ALTER TABLE vehicle_spins ADD COLUMN IF NOT EXISTS elevation SMALLINT NOT NULL DEFAULT 0
  CHECK (elevation >= -60 AND elevation <= 80);
CREATE INDEX IF NOT EXISTS vehicle_spins_row_of_idx ON vehicle_spins (row_of);

NOTIFY pgrst, 'reload schema';
