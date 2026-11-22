-- Rollback for migration-showcases-001.sql.
-- This drops only the tables/indexes/columns introduced by that migration.

DROP INDEX IF EXISTS collections_owner_updated_idx;
DROP INDEX IF EXISTS collection_items_collection_position_idx;
DROP TABLE IF EXISTS collection_items;

ALTER TABLE collections
  DROP COLUMN IF EXISTS is_published,
  DROP COLUMN IF EXISTS description;
