-- Rollback for migration-vehicle-hotspots.sql
DROP TABLE IF EXISTS vehicle_hotspots;
NOTIFY pgrst, 'reload schema';
