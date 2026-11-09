-- Rollback for migration-car-tour-photos.sql
ALTER TABLE property_media DROP COLUMN IF EXISTS caption;
NOTIFY pgrst, 'reload schema';
