-- Quote engine, migration 010: delivering a finished tour into the client's
-- account (Phase 5). Staff build the tour in the studio account as usual,
-- then send the client a single-use link. Nothing moves until the client,
-- signed in, accepts it.
--
--   * qe_deliveries: one row per link. Only the sha256 of the link's token
--     is stored; links expire.
--   * qe_delivery_accept: in one transaction, moves properties.user_id from
--     the studio account to the client, if the studio still owns the tour,
--     and recounts both accounts' usage_counters.
--   * qe_delivery_undo: an admin moves it back, if the client still owns it.
--
-- This is the only quote-engine migration that writes outside qe_*: it
-- changes properties.user_id (one row per accepted link) and recounts
-- usage_counters, using the same rules as POST /admin/users/:id/recalculate-usage.
-- Scenes, media and storage keys are not changed: media is found by
-- property, and files keep their keys.
-- Requires migrations 001-009.
-- Rollback: migration-quote-engine-010.down.sql (does not move tours back).

BEGIN;

CREATE TABLE IF NOT EXISTS public.qe_deliveries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID        NOT NULL REFERENCES public.qe_jobs(id) ON DELETE CASCADE,
  property_id    UUID        NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  from_user_id   UUID        NOT NULL,
  to_user_id     UUID,
  token_hash     TEXT        NOT NULL UNIQUE,
  status         TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'undone')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_by     UUID REFERENCES public.qe_staff(user_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at    TIMESTAMPTZ,
  undone_at      TIMESTAMPTZ,
  undone_by      UUID REFERENCES public.qe_staff(user_id)
);
CREATE INDEX IF NOT EXISTS qe_deliveries_job_idx ON public.qe_deliveries(job_id, created_at DESC);
-- One open link per tour
CREATE UNIQUE INDEX IF NOT EXISTS qe_deliveries_open_idx ON public.qe_deliveries(property_id) WHERE status = 'pending';
ALTER TABLE public.qe_deliveries ENABLE ROW LEVEL SECURITY;

-- Same counts as the admin's "recalculate usage"
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

-- Returns ok, not_pending, expired or owner_changed
CREATE OR REPLACE FUNCTION public.qe_delivery_accept(p_id UUID, p_user UUID) RETURNS TEXT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE d qe_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO d FROM qe_deliveries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'pending' THEN RETURN 'not_pending'; END IF;
  IF d.expires_at < now() THEN RETURN 'expired'; END IF;
  UPDATE properties SET user_id = p_user, updated_at = now() WHERE id = d.property_id AND user_id = d.from_user_id;
  IF NOT FOUND THEN RETURN 'owner_changed'; END IF;
  UPDATE qe_deliveries SET status = 'accepted', to_user_id = p_user, accepted_at = now() WHERE id = p_id;
  PERFORM qe_recount_usage(d.from_user_id);
  PERFORM qe_recount_usage(p_user);
  PERFORM qe_desk_audit(NULL, 'job', d.job_id::text, 'tour_delivered',
    jsonb_build_object('propertyId', d.property_id, 'userId', d.from_user_id),
    jsonb_build_object('propertyId', d.property_id, 'userId', p_user), NULL);
  RETURN 'ok';
END $$;

-- Returns ok, not_accepted or owner_changed
CREATE OR REPLACE FUNCTION public.qe_delivery_undo(p_id UUID, p_actor UUID, p_reason TEXT) RETURNS TEXT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE d qe_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO d FROM qe_deliveries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'accepted' THEN RETURN 'not_accepted'; END IF;
  UPDATE properties SET user_id = d.from_user_id, updated_at = now() WHERE id = d.property_id AND user_id = d.to_user_id;
  IF NOT FOUND THEN RETURN 'owner_changed'; END IF;
  UPDATE qe_deliveries SET status = 'undone', undone_at = now(), undone_by = p_actor WHERE id = p_id;
  PERFORM qe_recount_usage(d.from_user_id);
  PERFORM qe_recount_usage(d.to_user_id);
  PERFORM qe_desk_audit(p_actor, 'job', d.job_id::text, 'tour_delivery_undone',
    jsonb_build_object('propertyId', d.property_id, 'userId', d.to_user_id),
    jsonb_build_object('propertyId', d.property_id, 'userId', d.from_user_id), p_reason);
  RETURN 'ok';
END $$;

DO $$
DECLARE r TEXT; f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.qe_recount_usage(UUID)', 'public.qe_delivery_accept(UUID, UUID)', 'public.qe_delivery_undo(UUID, UUID, TEXT)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

-- The message staff send with the link (editable in Templates)
INSERT INTO public.qe_message_templates (key, channel, locale, version, subject, body) VALUES
('tour_delivery', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, your Viewora tour is ready. Open this link and sign in to add it to your account: {{delivery_link}}\n\nThe link works once and expires on {{expires_on}}.')
ON CONFLICT DO NOTHING;

COMMIT;
