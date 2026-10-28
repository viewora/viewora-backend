-- Quote engine, migration 009: ordering from a Viewora account (Phase 5b).
--   * qe_quote_requests.user_id: the signed-in user who started the form
--     from /app/capture. Set by the backend after it has checked the user's
--     session; the public form never sets it.
--   * qe_leads.user_id (from 001) is filled from it at the contact step:
--     once, the first time. A lead is never moved from one account to another.
-- Nothing outside qe_* is changed: properties and claim_tokens are not touched.
-- Requires migrations 001-008.
-- Rollback: migration-quote-engine-009.down.sql

BEGIN;

ALTER TABLE public.qe_quote_requests
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS qe_quote_requests_user_idx ON public.qe_quote_requests(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS qe_leads_user_idx ON public.qe_leads(user_id) WHERE user_id IS NOT NULL;

-- Ties a lead to an account if it has none yet. Returns true if it did.
CREATE OR REPLACE FUNCTION public.qe_lead_link_account(p_lead UUID, p_user UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_done BOOLEAN;
BEGIN
  UPDATE qe_leads SET user_id = p_user
  WHERE id = p_lead AND user_id IS NULL AND deleted_at IS NULL
  RETURNING true INTO v_done;
  IF v_done THEN
    PERFORM qe_desk_audit(NULL, 'lead', p_lead::text, 'account_linked', NULL, jsonb_build_object('userId', p_user), NULL);
  END IF;
  RETURN COALESCE(v_done, false);
END $$;

DO $$
DECLARE r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.qe_lead_link_account(UUID, UUID) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.qe_lead_link_account(UUID, UUID) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.qe_lead_link_account(UUID, UUID) TO service_role;
  END IF;
END $$;

COMMIT;
