-- Rollback of migration-spotlights.sql. Tours lose their spotlights; Studio keys stop working.
-- (Published files and voices stay on R2 under spaces/<id>/scenes/<id>/spotlights/ and go
-- with the tour when it is deleted.)
DROP TABLE IF EXISTS scene_spotlights;
DROP TABLE IF EXISTS scene_spotlight_files;
DROP TABLE IF EXISTS studio_keys;
NOTIFY pgrst, 'reload schema';
