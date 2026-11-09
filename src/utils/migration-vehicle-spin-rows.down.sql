-- Rollback for migration-vehicle-spin-rows.sql. Rows (spins with row_of) are deleted first.
DELETE FROM vehicle_spins WHERE row_of IS NOT NULL;
DROP INDEX IF EXISTS vehicle_spins_row_of_idx;
ALTER TABLE vehicle_spins DROP COLUMN IF EXISTS row_of;
ALTER TABLE vehicle_spins DROP COLUMN IF EXISTS elevation;
NOTIFY pgrst, 'reload schema';
