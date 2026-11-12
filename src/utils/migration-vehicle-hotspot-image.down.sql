-- Rollback for migration-vehicle-hotspot-image.sql
ALTER TABLE vehicle_hotspots DROP COLUMN IF EXISTS image_url;

NOTIFY pgrst, 'reload schema';
