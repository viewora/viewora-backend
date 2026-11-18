-- Rollback of migration-nadir-cover.sql. Tours simply lose their tripod cover.
ALTER TABLE property_360_settings
  DROP COLUMN IF EXISTS nadir_cover;
