-- Rollback for migration-vehicle-views.sql
DELETE FROM property_media WHERE media_type = 'vehicle_view';
DROP TABLE IF EXISTS vehicle_views;

DO $$
DECLARE con_name TEXT;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'property_media' AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%media_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE property_media DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE property_media
  ADD CONSTRAINT property_media_media_type_check CHECK (media_type IN (
    'panorama', 'gallery_image', 'thumbnail', 'logo', 'branding_logo', 'floor_plan', 'audio',
    'floor_plan_image'
  ));
