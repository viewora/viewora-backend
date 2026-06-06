-- Migration: medium-resolution tile support + scene spatial positions
-- Run in Supabase Dashboard > SQL Editor > New query

-- Medium-res tile columns (4096×2048 tile set for lite/mobile viewers)
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS tile_medium_manifest_url TEXT,
  ADD COLUMN IF NOT EXISTS tile_medium_cols          INTEGER,
  ADD COLUMN IF NOT EXISTS tile_medium_rows          INTEGER;

-- Spatial position columns (XY on a top-down floor plane, for minimap overlay)
-- Defaults to 0,0 — auto-assigned at scene creation, user-adjustable via PATCH /scenes/:id
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS position_x REAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS position_y REAL DEFAULT 0;

-- Backfill position_x for existing scenes: space them 3 units apart by order_index
-- so existing tours get a sensible linear layout in the minimap immediately.
UPDATE scenes s
SET position_x = s.order_index * 3.0
WHERE s.position_x = 0 AND s.order_index > 0;

-- NOTE: The get_tour_data() RPC must also be updated to return these new columns.
-- Open the Supabase SQL editor and add the new fields to the SELECT inside that function.
-- Without this the public viewer (/p/:slug) will not receive medium tile or position data.
