-- Migration: car hotspots that follow the car as it turns.
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-vehicle-hotspot-track.down.sql
-- Requires migration-vehicle-hotspots.sql to have run first.
--
-- Purely additive: one nullable column. `track` holds where the pin sits on each frame of a smooth
-- spin ({ "pts": { "<view id>": [x, y] }, "fixed": ["<view id>"] }), worked out in the editor.
-- Until it runs, pins show on the frames near the one they were placed on, as before.

ALTER TABLE vehicle_hotspots ADD COLUMN IF NOT EXISTS track JSONB;

NOTIFY pgrst, 'reload schema';
