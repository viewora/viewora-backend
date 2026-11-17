-- Rollback for migration-journeys.sql. Deletes every journey.
-- Hospital tours keep property_type 'hospital'; change them first if you also
-- need to restore an older property_type check constraint.
DROP TABLE IF EXISTS journeys;
NOTIFY pgrst, 'reload schema';
