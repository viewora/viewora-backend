-- Migration: venue maps (mall / campus directory + wayfinding) on floor plans
-- Run in Supabase Dashboard > SQL Editor > New query
--
-- Purely additive: one nullable jsonb column on floor_plans. Floors without
-- it are plain floor plans, exactly as before.
--
-- floor_plans.venue holds one floor's directory and walkways (coordinates
-- are fractions 0–1 of the plan image, like scene pins):
--   {
--     "places": [{ "id", "name", "category"?, "x", "y", "entrances"?: [node], "url"?, "logo"?, "text"? }],
--     "nodes":  [[x, y], ...],           -- walkway points
--     "edges":  [[a, b, flags?], ...],   -- walkway segments; flags & 1 = has steps (stairs / escalator)
--     "links":  [{ "node", "group", "kind"? }]  -- lift / escalator / stair ends; same group = connected across floors
--   }
-- Validated by PUT /floor-plans/:floorPlanId/venue.

ALTER TABLE floor_plans ADD COLUMN IF NOT EXISTS venue JSONB;
