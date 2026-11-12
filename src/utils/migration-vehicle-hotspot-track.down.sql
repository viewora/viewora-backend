-- Rollback for migration-vehicle-hotspot-track.sql
ALTER TABLE vehicle_hotspots DROP COLUMN IF EXISTS track;

NOTIFY pgrst, 'reload schema';
