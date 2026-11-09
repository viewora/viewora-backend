-- Rollback for migration-vehicle-identity.sql
ALTER TABLE properties DROP COLUMN IF EXISTS vehicle_vin;
ALTER TABLE properties DROP COLUMN IF EXISTS vehicle_make;
ALTER TABLE properties DROP COLUMN IF EXISTS vehicle_model;
ALTER TABLE properties DROP COLUMN IF EXISTS vehicle_trim;
NOTIFY pgrst, 'reload schema';
