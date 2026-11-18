-- Migration: tripod cover (the owner's logo drawn under the camera in every scene).
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-nadir-cover.down.sql
--
-- Purely additive. NULL = no cover (every existing tour, including ones with a
-- logo baked into the photos, looks exactly the same).
--
-- Shape (validated by PATCH /spaces/:id/settings, see nadirCoverSchema in routes/spaces.ts):
--   { "enabled": true, "mode": "all" | "some", "url": "https://…", "size": 18, "rotation": 0,
--     "fit": "fill" | "fit", "bg": "#ffffff" | null,
--     "scene_ids": [<scenes chosen in "some" mode>], "hidden_scene_ids": [<scenes left out in "all" mode>] }
--
-- get_tour_data() is NOT changed: routes/public.ts reads this column fresh on
-- every request (like social_links), and skips it while the column is missing.

ALTER TABLE property_360_settings
  ADD COLUMN IF NOT EXISTS nadir_cover JSONB;
