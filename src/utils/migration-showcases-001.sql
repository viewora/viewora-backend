-- Persistent, ordered public showcases. This is additive: the pre-existing
-- collections table remains compatible with its earlier (unused) definition.

ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS description TEXT NULL,
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, property_id),
  UNIQUE (collection_id, position)
);

CREATE INDEX IF NOT EXISTS collection_items_collection_position_idx
  ON collection_items (collection_id, position);

CREATE INDEX IF NOT EXISTS collections_owner_updated_idx
  ON collections (owner_id, updated_at DESC);
