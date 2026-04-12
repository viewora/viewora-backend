-- RPC function to find orphan media records (media with no parent property)
CREATE OR REPLACE FUNCTION find_orphan_media()
RETURNS TABLE (
  id uuid,
  storage_key text,
  file_size_bytes bigint
) LANGUAGE sql STABLE AS $$
  SELECT 
    pm.id,
    pm.storage_key,
    pm.file_size_bytes
  FROM property_media pm
  LEFT JOIN properties p ON pm.property_id = p.id
  WHERE p.id IS NULL
  AND pm.processing_status != 'deleted';
$$;

-- Add index for faster cleanup queries
CREATE INDEX IF NOT EXISTS idx_property_media_cleanup
  ON property_media (processing_status, marked_for_cleanup, marked_for_cleanup_at)
  WHERE processing_status = 'failed' AND marked_for_cleanup = true;
