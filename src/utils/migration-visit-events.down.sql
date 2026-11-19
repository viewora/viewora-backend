-- Rollback for migration-visit-events.sql.
DROP TABLE IF EXISTS visit_events;
NOTIFY pgrst, 'reload schema';
