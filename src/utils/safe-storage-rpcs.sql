-- Safe storage counter RPCs — GREATEST(0, ...) prevents negative values
-- Apply via Supabase SQL editor or MCP: mcp__supabase__execute_sql

CREATE OR REPLACE FUNCTION decrement_storage_usage(u_id uuid, bytes bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE usage_counters
  SET storage_used_bytes = GREATEST(0, storage_used_bytes - bytes)
  WHERE user_id = u_id;
END;
$$;

CREATE OR REPLACE FUNCTION increment_storage_usage(u_id uuid, bytes bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO usage_counters (user_id, storage_used_bytes)
  VALUES (u_id, bytes)
  ON CONFLICT (user_id)
  DO UPDATE SET storage_used_bytes = usage_counters.storage_used_bytes + EXCLUDED.storage_used_bytes;
END;
$$;
