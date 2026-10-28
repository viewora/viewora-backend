-- Quote engine, migration 007: links, QR codes and partners (Phase 4b).
--   * qe_entry_links (from 001) gains a kind, a label, an id for the admin,
--     and revocation. A 'dm' link is made for one named person: its code
--     column holds only the SHA-256 of the code, so the link cannot be
--     rebuilt from the database. A 'campaign' link (QR code, industry page)
--     carries no personal data and keeps its code as typed.
--   * qe_partners (from 001) gains updated_at; leads get an index on partner.
--   * qe_partner_payouts: commission paid to a partner, one row per job, so
--     a job can never be paid out twice.
--   * Functions for creating, using, listing and revoking links, crediting a
--     partner, saving partners, the commission report and recording
--     payouts. Changes write qe_audit_log.
-- Only qe_* tables are touched. Requires migrations 001-006.
-- Rollback: migration-quote-engine-007.down.sql

BEGIN;

-- ── Entry links ──────────────────────────────────────────────────────────
ALTER TABLE public.qe_entry_links
  ADD COLUMN IF NOT EXISTS id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS kind        TEXT        NOT NULL DEFAULT 'campaign' CHECK (kind IN ('dm', 'campaign')),
  ADD COLUMN IF NOT EXISTS label       TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by  UUID REFERENCES public.qe_staff(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS qe_entry_links_id_uidx ON public.qe_entry_links(id);
CREATE INDEX IF NOT EXISTS qe_entry_links_lead_idx ON public.qe_entry_links(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS qe_entry_links_created_idx ON public.qe_entry_links(kind, created_at DESC);
COMMENT ON COLUMN public.qe_entry_links.code IS 'campaign: the code as typed; dm: SHA-256 hex of the code (the code itself is never stored)';

-- ── Partners ─────────────────────────────────────────────────────────────
ALTER TABLE public.qe_partners ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS qe_leads_partner_idx ON public.qe_leads(partner_id) WHERE partner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.qe_partner_payouts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id         UUID        NOT NULL REFERENCES public.qe_partners(id),
  job_id             UUID        NOT NULL UNIQUE REFERENCES public.qe_jobs(id),
  amount             INTEGER     NOT NULL CHECK (amount >= 0),   -- whole KES, or USD cents
  currency           TEXT        NOT NULL DEFAULT 'KES',
  reference          TEXT,                                       -- M-Pesa or bank reference
  paid_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_by            UUID REFERENCES public.qe_staff(user_id)
);
CREATE INDEX IF NOT EXISTS qe_partner_payouts_partner_idx ON public.qe_partner_payouts(partner_id, paid_at DESC);
ALTER TABLE public.qe_partner_payouts ENABLE ROW LEVEL SECURITY;

-- ── Links ────────────────────────────────────────────────────────────────
-- A link for the admin (camelCase-free; the backend maps it). Includes the
-- stored code: the backend never sends a DM link's hash to the browser.
CREATE OR REPLACE FUNCTION public.qe_link_row(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT to_jsonb(l) || jsonb_build_object(
    'lead_name', CASE WHEN ld.deleted_at IS NULL THEN ld.first_name END,
    'created_by_name', s.display_name)
  FROM qe_entry_links l
  LEFT JOIN qe_leads ld ON ld.id = l.lead_id
  LEFT JOIN qe_staff s ON s.user_id = l.created_by
  WHERE l.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.qe_link_create(p_kind TEXT, p_code TEXT, p_label TEXT, p_prefill JSONB, p_lead UUID,
  p_actor UUID, p_max_uses INTEGER, p_expires_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO qe_entry_links (code, kind, label, prefill, lead_id, created_by, max_uses, expires_at)
  VALUES (p_code, p_kind, p_label, COALESCE(p_prefill, '{}'::jsonb), p_lead, p_actor, p_max_uses, p_expires_at)
  RETURNING id INTO v_id;
  PERFORM qe_desk_audit(p_actor, 'entry_link', v_id::text, 'created', NULL,
    jsonb_build_object('kind', p_kind, 'label', p_label, 'leadId', p_lead), NULL);
  RETURN qe_link_row(v_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'qe:code_taken';
END $$;

CREATE OR REPLACE FUNCTION public.qe_link_get(p_code TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT qe_link_row(id) FROM qe_entry_links WHERE code = p_code
$$;

-- One start of the form from this link. Counts the use only while the link
-- is active, in the same transaction as the check.
CREATE OR REPLACE FUNCTION public.qe_link_use(p_code TEXT, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE l qe_entry_links; v_state TEXT;
BEGIN
  SELECT * INTO l FROM qe_entry_links WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  v_state := CASE
    WHEN l.revoked_at IS NOT NULL THEN 'revoked'
    WHEN l.expires_at IS NOT NULL AND l.expires_at <= p_now THEN 'expired'
    WHEN l.max_uses IS NOT NULL AND l.uses >= l.max_uses THEN 'used_up'
    ELSE 'active' END;
  IF v_state = 'active' THEN
    UPDATE qe_entry_links SET uses = uses + 1 WHERE id = l.id;
  END IF;
  RETURN jsonb_build_object('link', qe_link_row(l.id), 'state', v_state);
END $$;

CREATE OR REPLACE FUNCTION public.qe_link_list(p_kind TEXT, p_lead UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(qe_link_row(id) ORDER BY created_at DESC), '[]'::jsonb)
  FROM (
    SELECT id, created_at FROM qe_entry_links
    WHERE (p_kind IS NULL OR kind = p_kind) AND (p_lead IS NULL OR lead_id = p_lead)
    ORDER BY created_at DESC LIMIT 500
  ) x
$$;

CREATE OR REPLACE FUNCTION public.qe_link_revoke(p_id UUID, p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE qe_entry_links SET revoked_at = now(), revoked_by = p_actor WHERE id = p_id AND revoked_at IS NULL;
  IF FOUND THEN
    PERFORM qe_desk_audit(p_actor, 'entry_link', p_id::text, 'revoked', NULL, NULL, NULL);
  END IF;
  RETURN qe_link_row(p_id);
END $$;

-- The visitor gave their number. A DM link is tied to that lead, and the
-- person who made it owns the lead unless someone already does.
CREATE OR REPLACE FUNCTION public.qe_link_attach(p_code TEXT, p_lead UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE l qe_entry_links;
BEGIN
  SELECT * INTO l FROM qe_entry_links WHERE code = p_code AND kind = 'dm';
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE qe_entry_links SET lead_id = p_lead WHERE id = l.id AND lead_id IS NULL;
  IF l.created_by IS NOT NULL THEN
    UPDATE qe_leads SET owner_staff_id = l.created_by WHERE id = p_lead AND owner_staff_id IS NULL;
    IF FOUND THEN
      PERFORM qe_desk_audit(NULL, 'lead', p_lead::text, 'owner_from_link', NULL,
        jsonb_build_object('ownerStaffId', l.created_by, 'linkId', l.id), NULL);
    END IF;
  END IF;
END $$;

-- ── Partners ─────────────────────────────────────────────────────────────
-- First partner to bring a lead keeps it
CREATE OR REPLACE FUNCTION public.qe_partner_credit(p_lead UUID, p_code TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_partner UUID;
BEGIN
  SELECT id INTO v_partner FROM qe_partners WHERE code = p_code AND active;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE qe_leads SET partner_id = v_partner WHERE id = p_lead AND partner_id IS NULL AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM qe_desk_audit(NULL, 'lead', p_lead::text, 'partner_credited', NULL, jsonb_build_object('partnerId', v_partner), NULL);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.qe_partner_list() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p) || jsonb_build_object('leads',
    (SELECT count(*) FROM qe_leads l WHERE l.partner_id = p.id AND l.deleted_at IS NULL)) ORDER BY p.name), '[]'::jsonb)
  FROM qe_partners p
$$;

-- Create (p_id NULL) or change a partner. p holds only the fields to set.
CREATE OR REPLACE FUNCTION public.qe_partner_save(p_id UUID, p JSONB, p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_before JSONB; v_id UUID := p_id;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO qe_partners (name, code, commission_type, commission_value, active)
    VALUES (p->>'name', p->>'code', p->>'commission_type', (p->>'commission_value')::int, COALESCE((p->>'active')::boolean, true))
    RETURNING id INTO v_id;
    PERFORM qe_desk_audit(p_actor, 'partner', v_id::text, 'created', NULL, p, NULL);
  ELSE
    SELECT to_jsonb(x) INTO v_before FROM qe_partners x WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    UPDATE qe_partners SET
      name = COALESCE(p->>'name', name),
      code = COALESCE(p->>'code', code),
      commission_type = COALESCE(p->>'commission_type', commission_type),
      commission_value = COALESCE((p->>'commission_value')::int, commission_value),
      active = COALESCE((p->>'active')::boolean, active),
      updated_at = now()
    WHERE id = p_id;
    PERFORM qe_desk_audit(p_actor, 'partner', p_id::text, 'updated', v_before, p, NULL);
  END IF;
  RETURN (SELECT to_jsonb(x) || jsonb_build_object('leads',
    (SELECT count(*) FROM qe_leads l WHERE l.partner_id = x.id AND l.deleted_at IS NULL)) FROM qe_partners x WHERE id = v_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'qe:code_taken';
END $$;

-- Every job a partner brought, with the price before VAT of the option
-- booked. The backend works out what is owed (links.ts commissionFor).
CREATE OR REPLACE FUNCTION public.qe_commission_jobs(p_partner UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'job_id', j.id, 'job_ref', j.ref, 'lead_id', l.id,
    'lead_name', CASE WHEN l.deleted_at IS NULL THEN l.first_name END,
    'partner_id', p.id, 'partner_name', p.name, 'partner_code', p.code,
    'commission_type', p.commission_type, 'commission_value', p.commission_value,
    'currency', j.currency, 'net', o.net, 'status', j.status,
    'deposit_status', j.deposit_status, 'balance_status', j.balance_status, 'balance_paid_at', j.balance_paid_at,
    'payout_id', po.id, 'payout_amount', po.amount, 'payout_reference', po.reference,
    'payout_paid_at', po.paid_at, 'payout_paid_by_name', s.display_name
  ) ORDER BY j.balance_paid_at DESC NULLS LAST, j.ref), '[]'::jsonb)
  FROM qe_jobs j
  JOIN qe_leads l ON l.id = j.lead_id
  JOIN qe_partners p ON p.id = l.partner_id
  JOIN qe_quote_options o ON o.id = j.option_id
  LEFT JOIN qe_partner_payouts po ON po.job_id = j.id
  LEFT JOIN qe_staff s ON s.user_id = po.paid_by
  WHERE p_partner IS NULL OR p.id = p_partner
$$;

-- Payouts for jobs not yet paid out. p_items: [{"job_id", "amount"}].
-- The backend checks each job is owed first; this keeps it to one per job.
CREATE OR REPLACE FUNCTION public.qe_partner_payouts_record(p_items JSONB, p_reference TEXT, p_actor UUID)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE item JSONB; v_id UUID; v_n INTEGER := 0;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO qe_partner_payouts (partner_id, job_id, amount, currency, reference, paid_by)
    SELECT l.partner_id, j.id, (item->>'amount')::int, j.currency, p_reference, p_actor
    FROM qe_jobs j JOIN qe_leads l ON l.id = j.lead_id
    WHERE j.id = (item->>'job_id')::uuid AND l.partner_id IS NOT NULL
    ON CONFLICT (job_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_n := v_n + 1;
      PERFORM qe_desk_audit(p_actor, 'partner_payout', v_id::text, 'recorded', NULL,
        jsonb_build_object('jobId', item->>'job_id', 'amount', (item->>'amount')::int, 'reference', p_reference), NULL);
    END IF;
    v_id := NULL;
  END LOOP;
  RETURN v_n;
END $$;

-- ── Only the service role (the backend) may call these ───────────────────
DO $$
DECLARE
  f TEXT;
  r TEXT;
  fns TEXT[] := ARRAY[
    'qe_link_row(UUID)', 'qe_link_create(TEXT, TEXT, TEXT, JSONB, UUID, UUID, INTEGER, TIMESTAMPTZ)',
    'qe_link_get(TEXT)', 'qe_link_use(TEXT, TIMESTAMPTZ)', 'qe_link_list(TEXT, UUID)',
    'qe_link_revoke(UUID, UUID)', 'qe_link_attach(TEXT, UUID)', 'qe_partner_credit(UUID, TEXT)',
    'qe_partner_list()', 'qe_partner_save(UUID, JSONB, UUID)', 'qe_commission_jobs(UUID)',
    'qe_partner_payouts_record(JSONB, TEXT, UUID)'
  ];
BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
    END IF;
  END LOOP;
END $$;

COMMIT;
