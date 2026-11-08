-- Migration: single-vehicle exterior views (drag-to-rotate photo set)
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-vehicle-views.down.sql
--
-- Additive: one new table plus a wider media_type check (adds 'vehicle_view').
-- Each row is one normal photo of the outside of a car, taken at `angle`
-- degrees around it (0 = front, 90 = right side, 180 = rear, 270 = left side).
-- Interior shots are ordinary 360 scenes, so they need nothing new here.

CREATE TABLE IF NOT EXISTS vehicle_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  media_id UUID,
  image_url TEXT NOT NULL,
  label TEXT,
  angle SMALLINT NOT NULL DEFAULT 0 CHECK (angle >= 0 AND angle < 360),
  width INTEGER,
  height INTEGER,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_views_space_id_idx ON vehicle_views (space_id, order_index);

-- Only the backend (service key) reads/writes this table.
ALTER TABLE vehicle_views ENABLE ROW LEVEL SECURITY;

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
    'floor_plan_image', 'vehicle_view'
  ));
