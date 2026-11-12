-- Migration: enforce the tour limit in the database, counting every tour (drafts included)
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-tour-quota-enforcement.down.sql
--
-- Why:
--  * The limit used to be checked in the API against usage_counters.active_properties_count,
--    a counter kept by increment/decrement RPC calls. Check → insert → increment was not
--    atomic, so parallel creates could go past the limit, and any delete path that skipped
--    the RPC (admin deletes, cascades, ownership transfers) made the counter drift and
--    block users who were really under their limit.
--  * Now: a BEFORE INSERT trigger on properties takes a per-user lock, counts the user's
--    real rows and rejects the insert when the plan limit is reached. The counter is kept
--    by triggers as a recount (never +1/-1), so it can't drift; it is for display only.
--  * "Tours" = every row in properties for the user, published or not, because drafts use
--    the same storage and processing as live tours.
--
-- Deploy order: run this migration, then deploy the backend that stops calling
-- increment_active_properties / decrement_active_properties.

-- ── Plan limit for a user (NULL = unlimited) ─────────────────────────────────
-- Mirrors checkUserQuota(): the subscription's plan if the user has a subscription row,
-- otherwise the free plan.
CREATE OR REPLACE FUNCTION public.tour_limit_for_user(p_user UUID) RETURNS INTEGER
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_max INTEGER;
BEGIN
  SELECT pl.max_active_properties INTO v_max
  FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
  WHERE s.user_id = p_user
  LIMIT 1;
  IF FOUND THEN RETURN v_max; END IF;

  SELECT max_active_properties INTO v_max FROM plans WHERE slug = 'free';
  RETURN v_max;
END $$;

-- ── Enforcement: BEFORE INSERT ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_tour_limit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_max   INTEGER;
  v_count INTEGER;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- Serialise creates per user until commit, so two parallel inserts can't both see
  -- count = limit - 1. Each statement below takes a fresh snapshot (READ COMMITTED),
  -- so the second insert counts the first one once the lock is released.
  PERFORM pg_advisory_xact_lock(hashtextextended('tour_quota:' || NEW.user_id::text, 0));

  v_max := tour_limit_for_user(NEW.user_id);
  IF v_max IS NULL THEN RETURN NEW; END IF;  -- unlimited (custom / Enterprise)

  SELECT COUNT(*) INTO v_count FROM properties WHERE user_id = NEW.user_id;
  IF v_count >= v_max THEN
    RAISE EXCEPTION 'TOUR_LIMIT_REACHED'
      USING ERRCODE = 'P0001',
            DETAIL  = format('%s of %s tours used', v_count, v_max);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS properties_enforce_tour_limit ON public.properties;
CREATE TRIGGER properties_enforce_tour_limit
  BEFORE INSERT ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tour_limit();

-- ── Display counter: recount on every change of ownership ─────────────────────
CREATE OR REPLACE FUNCTION public.sync_tour_count() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.user_id IS NOT NULL THEN
    INSERT INTO usage_counters (user_id, storage_used_bytes, active_properties_count, updated_at)
    VALUES (NEW.user_id, 0, (SELECT COUNT(*) FROM properties WHERE user_id = NEW.user_id), now())
    ON CONFLICT (user_id) DO UPDATE SET
      active_properties_count = EXCLUDED.active_properties_count,
      updated_at = now();
  END IF;

  -- Old owner: UPDATE only (no insert), so a cascade from deleting the user can't try to
  -- recreate their usage_counters row.
  IF TG_OP IN ('DELETE', 'UPDATE') AND OLD.user_id IS NOT NULL THEN
    UPDATE usage_counters
    SET active_properties_count = (SELECT COUNT(*) FROM properties WHERE user_id = OLD.user_id),
        updated_at = now()
    WHERE user_id = OLD.user_id;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS properties_sync_tour_count_ins_del ON public.properties;
CREATE TRIGGER properties_sync_tour_count_ins_del
  AFTER INSERT OR DELETE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.sync_tour_count();

DROP TRIGGER IF EXISTS properties_sync_tour_count_owner ON public.properties;
CREATE TRIGGER properties_sync_tour_count_owner
  AFTER UPDATE OF user_id ON public.properties
  FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION public.sync_tour_count();

-- Trigger functions must not be callable directly through PostgREST.
REVOKE ALL ON FUNCTION public.enforce_tour_limit()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_tour_count()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tour_limit_for_user(UUID)   FROM PUBLIC, anon, authenticated;

-- ── Quote-engine recount: count all tours, same as everything else now ────────
CREATE OR REPLACE FUNCTION public.qe_recount_usage(p_user UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO usage_counters (user_id, storage_used_bytes, active_properties_count, updated_at)
  SELECT p_user,
    COALESCE((SELECT SUM(m.file_size_bytes) FROM property_media m JOIN properties p ON p.id = m.property_id WHERE p.user_id = p_user), 0),
    (SELECT COUNT(*) FROM properties WHERE user_id = p_user),
    now()
  ON CONFLICT (user_id) DO UPDATE SET
    storage_used_bytes = EXCLUDED.storage_used_bytes,
    active_properties_count = EXCLUDED.active_properties_count,
    updated_at = now();
END $$;

-- ── Backfill: fix every existing counter (this is what unblocks drifted accounts) ─
UPDATE usage_counters uc
SET active_properties_count = (SELECT COUNT(*) FROM properties p WHERE p.user_id = uc.user_id),
    updated_at = now();

NOTIFY pgrst, 'reload schema';
