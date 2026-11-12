-- Migration: a photo on a car hotspot (tap the pin on the bonnet, see the engine bay).
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-vehicle-hotspot-image.down.sql
-- Requires migration-vehicle-hotspots.sql to have run first.
--
-- Purely additive: one nullable column. Until it runs, the API keeps serving hotspots without photos.

ALTER TABLE vehicle_hotspots ADD COLUMN IF NOT EXISTS image_url TEXT;

NOTIFY pgrst, 'reload schema';
