-- Rollback for migration-vehicle-spins.sql
-- Photos stay; they just stop belonging to a spin (every car goes back to a single exterior set).
ALTER TABLE vehicle_views DROP COLUMN IF EXISTS spin_id;
DROP TABLE IF EXISTS vehicle_spins;
NOTIFY pgrst, 'reload schema';
