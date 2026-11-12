-- Rollback for migration-tour-quota-enforcement.sql
-- Also roll the backend back to the version that calls increment/decrement_active_properties,
-- otherwise the counter stops updating.
DROP TRIGGER IF EXISTS properties_enforce_tour_limit ON public.properties;
DROP TRIGGER IF EXISTS properties_sync_tour_count_ins_del ON public.properties;
DROP TRIGGER IF EXISTS properties_sync_tour_count_owner ON public.properties;
DROP FUNCTION IF EXISTS public.enforce_tour_limit();
DROP FUNCTION IF EXISTS public.sync_tour_count();
DROP FUNCTION IF EXISTS public.tour_limit_for_user(UUID);

-- Restore the published-only recount from migration-quote-engine-010.sql
CREATE OR REPLACE FUNCTION public.qe_recount_usage(p_user UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO usage_counters (user_id, storage_used_bytes, active_properties_count, updated_at)
  SELECT p_user,
    COALESCE((SELECT SUM(m.file_size_bytes) FROM property_media m JOIN properties p ON p.id = m.property_id WHERE p.user_id = p_user), 0),
    (SELECT COUNT(*) FROM properties WHERE user_id = p_user AND is_published),
    now()
  ON CONFLICT (user_id) DO UPDATE SET
    storage_used_bytes = EXCLUDED.storage_used_bytes,
    active_properties_count = EXCLUDED.active_properties_count,
    updated_at = now();
END $$;

NOTIFY pgrst, 'reload schema';
