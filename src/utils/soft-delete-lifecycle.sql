-- Soft Delete Lifecycle (Future Evolution)
-- State machine: active -> mark_deleted -> retention -> hard_delete
--
-- This migration is intentionally additive and backward-compatible.

-- 1) Add lifecycle columns to property_media.
ALTER TABLE property_media
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS marked_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS hard_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_reason text;

-- 2) Constrain lifecycle state values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'property_media_lifecycle_state_check'
  ) THEN
    ALTER TABLE property_media
      ADD CONSTRAINT property_media_lifecycle_state_check
      CHECK (lifecycle_state IN ('active', 'mark_deleted', 'retention', 'hard_deleted'));
  END IF;
END $$;

-- 3) Helpful index for cleanup scans.
CREATE INDEX IF NOT EXISTS idx_property_media_lifecycle_retention
  ON property_media (lifecycle_state, retention_expires_at)
  WHERE lifecycle_state IN ('mark_deleted', 'retention');

-- 4) Transition helper: mark for soft delete.
CREATE OR REPLACE FUNCTION mark_media_deleted(
  p_media_id uuid,
  p_reason text,
  p_retention_interval interval DEFAULT interval '7 days'
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE property_media
  SET lifecycle_state = 'mark_deleted',
      marked_deleted_at = now(),
      retention_expires_at = now() + p_retention_interval,
      deletion_reason = p_reason,
      updated_at = now()
  WHERE id = p_media_id
    AND lifecycle_state = 'active';
END;
$$;

-- 5) Transition helper: promote to retention window.
CREATE OR REPLACE FUNCTION promote_media_to_retention()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_count bigint;
BEGIN
  UPDATE property_media
  SET lifecycle_state = 'retention',
      updated_at = now()
  WHERE lifecycle_state = 'mark_deleted';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 6) Candidate selector for hard delete worker.
CREATE OR REPLACE FUNCTION find_hard_delete_candidates()
RETURNS TABLE (
  id uuid,
  storage_key text,
  file_size_bytes bigint,
  property_id uuid,
  user_id uuid
)
LANGUAGE sql
STABLE
AS $$
  SELECT id, storage_key, file_size_bytes, property_id, user_id
  FROM property_media
  WHERE lifecycle_state = 'retention'
    AND retention_expires_at IS NOT NULL
    AND retention_expires_at < now();
$$;
