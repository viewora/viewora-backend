-- Migration: patient journeys (self-playing guided visits) + the 'hospital' tour type.
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-journeys.down.sql
--
-- Purely additive: one new table. Tours without a journey are unaffected.
--
-- A journey is one pathway through a tour ("Outpatient visit", "Maternity
-- admission"). Its steps are stored as one JSON document so a save is a single
-- atomic write (never half a journey):
--   steps = [{ id, title, scene_id, view: { yaw, pitch } | null,
--              sentences: [{ id, text }] }]
-- view yaw/pitch are radians as PSV reports them. The app turns the steps into
-- what the viewer plays (shared/utils/journey.ts, compileJourney).

CREATE TABLE IF NOT EXISTS journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Patient visit',
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_published BOOLEAN NOT NULL DEFAULT false,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS journeys_space_id_idx ON journeys (space_id);

-- Only the backend (service key) reads/writes this table.
ALTER TABLE journeys ENABLE ROW LEVEL SECURITY;

-- New tour type 'hospital'. If properties.property_type has a check
-- constraint, replace it with the API's list plus 'hospital' (looked up by
-- definition, since its name isn't recorded in this repo). NOT VALID: existing
-- rows aren't re-checked. No constraint (plain text column): nothing to do.
DO $$
DECLARE con_name TEXT;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'properties' AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%property_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE properties DROP CONSTRAINT %I', con_name);
    ALTER TABLE properties
      ADD CONSTRAINT properties_property_type_check CHECK (property_type IS NULL OR property_type IN (
        'residential', 'commercial', 'hospitality', 'education', 'automotive', 'land', 'other', 'hospital'
      )) NOT VALID;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
