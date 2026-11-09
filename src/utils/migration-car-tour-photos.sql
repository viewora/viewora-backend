-- Migration: names for a car's detail photos ("Wheels", "Dashboard")
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-car-tour-photos.down.sql
--
-- Additive: one nullable column. The car tour shows the name under each detail
-- photo's thumbnail. Other listings ignore it.
ALTER TABLE property_media ADD COLUMN IF NOT EXISTS caption TEXT;

NOTIFY pgrst, 'reload schema';
