-- Migration: visit events (what visitors do inside a tour with guided visits).
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-visit-events.down.sql
--
-- Purely additive: one new table. Nothing reads it except the owner's
-- dashboard (GET /analytics/visits). Rows are anonymous: a random visitor id
-- kept in the visitor's browser and a random id per page load (session), no
-- IP address, no name.
--
-- Events (POST /analytics/events, sent in batches by the viewer):
--   tour_open      a page load (meta.device = phone | tablet | desktop)
--   session_end    leaving the page, value = ms spent
--   scene_view     entering a photo (scene_id)
--   visit_start    a guided visit started (journey_id)
--   step_reached   a visit reached step `step` (0-based)
--   visit_complete a visit played to the end, value = ms it took
--   visit_exit     a visit closed early, at step `step`
--   area_open      an area chosen in the side list (scene_id)
--   area_complete  that area's guide played to the end (scene_id)
--   route_start    directions asked for: scene_id = destination, meta.from = start scene
--   route_arrive   the walk reached the destination (scene_id)

CREATE TABLE IF NOT EXISTS visit_events (
  id BIGSERIAL PRIMARY KEY,
  space_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  journey_id UUID,
  scene_id UUID,
  step INTEGER,
  value INTEGER,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visit_events_space_time_idx ON visit_events (space_id, created_at DESC);

-- Only the backend (service key) reads/writes this table.
ALTER TABLE visit_events ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
