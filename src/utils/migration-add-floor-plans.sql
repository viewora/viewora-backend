-- Migration: uploaded floor plans + scene pins on them
-- Run in Supabase Dashboard > SQL Editor > New query
--
-- Purely additive: one new table, four nullable columns on scenes.
-- Tours without a floor plan are unaffected.
--
-- A space can have several floors ("Ground Floor", "First Floor"…). Each
-- scene can be pinned on one floor; plan_x / plan_y are fractions (0–1) of the
-- plan image's width / height so pins survive the image being resized.

CREATE TABLE IF NOT EXISTS floor_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Floor plan',
  image_url TEXT NOT NULL,
  media_id UUID,
  width INTEGER,
  height INTEGER,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS floor_plans_space_id_idx ON floor_plans (space_id);

-- Only the backend (service key) reads/writes this table.
ALTER TABLE floor_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS floor_plan_id UUID REFERENCES floor_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS plan_x REAL CHECK (plan_x IS NULL OR (plan_x >= 0 AND plan_x <= 1)),
  ADD COLUMN IF NOT EXISTS plan_y REAL CHECK (plan_y IS NULL OR (plan_y >= 0 AND plan_y <= 1)),
  -- Degrees to add to the scene's yaw so the minimap's direction cone matches
  -- the plan (0 = the panorama's centre faces "up" on the plan).
  ADD COLUMN IF NOT EXISTS north_offset REAL CHECK (north_offset IS NULL OR (north_offset >= -180 AND north_offset <= 180));

CREATE INDEX IF NOT EXISTS scenes_floor_plan_id_idx ON scenes (floor_plan_id);

-- Allow the new 'floor_plan_image' upload type in property_media. The
-- existing check constraint is replaced with the same list plus the new value
-- (looked up by definition, since its name isn't recorded in this repo).
DO $$
DECLARE con_name TEXT;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'property_media' AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%media_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE property_media DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE property_media
  ADD CONSTRAINT property_media_media_type_check CHECK (media_type IN (
    'panorama', 'gallery_image', 'thumbnail', 'logo', 'branding_logo', 'floor_plan', 'audio',
    'floor_plan_image'
  ));
