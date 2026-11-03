-- Migration: route coverage gaps
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- When a visitor asks the venue map for directions and the 360 tour can't walk
-- that route (no hotspots on the direct way, only a long detour, or the place
-- isn't covered at all), the viewer logs it here. One row per distinct
-- (space, from, to, reason); `hits` counts how often visitors asked, so the
-- most-requested gaps float to the top and get hotspots first.

CREATE TABLE IF NOT EXISTS route_coverage_gaps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- Where from: a place key ("floorId:placeId"), or "scene:<id>" for the visitor's own 360 view
  from_ref        text NOT NULL,
  from_name       text NOT NULL DEFAULT '',
  from_floor_id   text,
  to_ref          text NOT NULL,
  to_name         text NOT NULL DEFAULT '',
  to_floor_id     text,
  -- destination: tour doesn't cover the place · start: no hotspot path from the start
  -- detour: hotspots only go the long way round · partial: walk stops short of the place
  reason          text NOT NULL CHECK (reason IN ('destination', 'start', 'detour', 'partial')),
  start_scene_id  text,
  direct_length   numeric,
  hits            integer NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  note            text,
  UNIQUE (property_id, from_ref, to_ref, reason)
);

CREATE INDEX IF NOT EXISTS route_coverage_gaps_property_hits_idx
  ON route_coverage_gaps (property_id, status, hits DESC);

-- Written and read only through the backend (service role).
ALTER TABLE route_coverage_gaps ENABLE ROW LEVEL SECURITY;

-- Atomic "count another visitor": insert, or bump hits on the existing row.
-- A gap marked resolved that visitors hit again is reopened; ignored stays ignored.
CREATE OR REPLACE FUNCTION log_route_gap(
  p_property_id uuid, p_from_ref text, p_from_name text, p_from_floor_id text,
  p_to_ref text, p_to_name text, p_to_floor_id text,
  p_reason text, p_start_scene_id text, p_direct_length numeric
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO route_coverage_gaps
    (property_id, from_ref, from_name, from_floor_id, to_ref, to_name, to_floor_id, reason, start_scene_id, direct_length)
  VALUES
    (p_property_id, p_from_ref, p_from_name, p_from_floor_id, p_to_ref, p_to_name, p_to_floor_id, p_reason, p_start_scene_id, p_direct_length)
  ON CONFLICT (property_id, from_ref, to_ref, reason) DO UPDATE SET
    hits = route_coverage_gaps.hits + 1,
    last_seen_at = now(),
    from_name = EXCLUDED.from_name,
    to_name = EXCLUDED.to_name,
    direct_length = EXCLUDED.direct_length,
    status = CASE WHEN route_coverage_gaps.status = 'resolved' THEN 'open' ELSE route_coverage_gaps.status END;
$$;
