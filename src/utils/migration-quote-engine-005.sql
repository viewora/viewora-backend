-- Quote engine, migration 005: deposits and jobs (Phase 3).
--   * qe_payments (from 001) gains what a Paystack payment needs: the option
--     paid for, the checkout link, how it was paid, test or live, and
--     manual balance payments recorded by staff.
--   * qe_jobs (from 001) gains a status, the shoot slot (morning or
--     afternoon, requested by the client or confirmed by staff), a short
--     reference, and one job per quote.
--   * qe_invoices: one row per successful payment, waiting for KRA eTIMS
--     (the backend hook is in src/quote/invoicing.ts).
--   * qe_settings: booking rules (shoots per slot, days off, notice).
--   * Wording for the deposit confirmation, the balance request and the
--     staff alert.
--   * Functions for paying, settling a payment exactly once, and running
--     jobs. Each is one transaction and writes qe_audit_log.
-- Only qe_* tables are touched. Requires migrations 001-004.
-- Rollback: migration-quote-engine-005.down.sql

BEGIN;

-- ── Payments ─────────────────────────────────────────────────────────────
ALTER TABLE public.qe_payments DROP CONSTRAINT IF EXISTS qe_payments_status_check;
ALTER TABLE public.qe_payments ADD CONSTRAINT qe_payments_status_check
  CHECK (status IN ('initialized', 'success', 'failed', 'abandoned'));
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS tier TEXT;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS link_id UUID REFERENCES public.qe_quote_links(id) ON DELETE SET NULL;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS authorization_url TEXT;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS channel TEXT;          -- card, mobile_money, cash, bank...
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS live BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS recorded_by UUID REFERENCES public.qe_staff(user_id);
ALTER TABLE public.qe_payments ADD COLUMN IF NOT EXISTS note TEXT;
CREATE INDEX IF NOT EXISTS qe_payments_pending_idx ON public.qe_payments(created_at) WHERE status = 'initialized';
CREATE INDEX IF NOT EXISTS qe_payments_quote_idx ON public.qe_payments(quote_id);
CREATE INDEX IF NOT EXISTS qe_payments_job_idx ON public.qe_payments(job_id);

-- ── Jobs ─────────────────────────────────────────────────────────────────
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS ref TEXT UNIQUE;
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS tier TEXT;
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'booked'
  CHECK (status IN ('booked', 'scheduled', 'shot', 'delivered', 'closed', 'cancelled'));
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS shoot_window TEXT CHECK (shoot_window IN ('morning', 'afternoon'));
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS shoot_date_status TEXT NOT NULL DEFAULT 'none'
  CHECK (shoot_date_status IN ('none', 'requested', 'confirmed'));
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ;
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS balance_paid_at TIMESTAMPTZ;
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE public.qe_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS qe_jobs_quote_uidx ON public.qe_jobs(quote_id);
CREATE INDEX IF NOT EXISTS qe_jobs_shoot_idx ON public.qe_jobs(shoot_date) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS qe_jobs_lead_idx ON public.qe_jobs(lead_id);

ALTER TABLE public.qe_job_costs ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.qe_staff(user_id);

-- ── Invoices (KRA eTIMS) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qe_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID        NOT NULL REFERENCES public.qe_jobs(id) ON DELETE CASCADE,
  payment_id         UUID        NOT NULL UNIQUE REFERENCES public.qe_payments(id) ON DELETE CASCADE,
  status             TEXT        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'issued', 'failed', 'not_configured')),
  provider           TEXT,                       -- the eTIMS solution the accountant picks
  external_ref       TEXT,                       -- e.g. the KRA control unit invoice number
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.qe_invoices ENABLE ROW LEVEL SECURITY;

-- ── Settings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qe_settings (
  key                TEXT PRIMARY KEY,
  value              JSONB       NOT NULL,
  updated_by         UUID REFERENCES public.qe_staff(user_id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.qe_settings ENABLE ROW LEVEL SECURITY;
-- Days are 0 = Sunday … 6 = Saturday. Staff change these in the admin.
INSERT INTO public.qe_settings (key, value) VALUES
  ('booking', '{"perSlot": 1, "windows": ["morning", "afternoon"], "daysOff": [0], "noticeDays": 2, "horizonDays": 45}')
ON CONFLICT DO NOTHING;

-- ── Wording ──────────────────────────────────────────────────────────────
INSERT INTO public.qe_message_templates (key, channel, locale, version, subject, body) VALUES
(
  'deposit_paid', 'email', 'en', 1,
  'Deposit received: {{amount}} for your Viewora tour',
  E'Hi {{name}},\n\nThank you. We received your deposit of {{amount}} for the {{option}} option (quote {{quote_ref}}).\n\nIf you have not picked a shoot day yet, open your quote link again and choose one there. We will confirm the day on WhatsApp.\n\nBefore the shoot:\n- Tidy each room and open the curtains.\n- Switch on every light.\n- Move cars, bins and personal items out of view.\n\nThe balance of {{balance}} is due when we deliver your tour.\n\nThe Viewora team'
),
(
  'balance_request', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, your Viewora tour is ready. The balance is {{amount}}. You can pay by M-Pesa or card here: {{pay_link}}\n\nThank you!'
),
(
  'staff_deposit_paid', 'email', 'en', 1,
  'Deposit paid: {{name}}, {{amount}}',
  E'{{name}} paid a {{amount}} deposit for {{industry}} ({{option}}, quote {{quote_ref}}).\n\nThey will pick a shoot day on the quote page. Open the job: {{admin_link}}'
)
ON CONFLICT DO NOTHING;

-- ── Helpers ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_pay_row(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'reference', p.reference, 'kind', p.kind, 'provider', p.provider, 'status', p.status,
    'amount', p.amount, 'currency', p.currency, 'tier', p.tier, 'channel', p.channel,
    'paidAt', p.paid_at, 'failureReason', p.failure_reason, 'authorizationUrl', p.authorization_url,
    'live', p.live, 'quoteId', p.quote_id, 'jobId', p.job_id, 'linkId', p.link_id, 'checks', p.checks,
    'note', p.note, 'recordedByName', s.display_name, 'createdAt', p.created_at
  )
  FROM qe_payments p LEFT JOIN qe_staff s ON s.user_id = p.recorded_by
  WHERE p.id = p_id
$$;

-- A job as the TypeScript JobRecord (camelCase JSON)
CREATE OR REPLACE FUNCTION public.qe_job_row(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', j.id, 'ref', j.ref, 'quoteId', j.quote_id, 'leadId', j.lead_id, 'requestId', q.request_id,
    'quoteVersion', q.version, 'tier', j.tier, 'status', j.status,
    'price', j.price, 'currency', j.currency,
    'depositAmount', j.deposit_amount, 'depositStatus', j.deposit_status, 'depositPaidAt', j.deposit_paid_at,
    'balanceAmount', j.balance_amount, 'balanceStatus', j.balance_status, 'balancePaidAt', j.balance_paid_at,
    'shootDate', to_char(j.shoot_date, 'YYYY-MM-DD'), 'shootWindow', j.shoot_window, 'shootDateStatus', j.shoot_date_status,
    'locationText', j.location_text, 'locationLat', j.location_lat, 'locationLng', j.location_lng,
    'assignedStaffId', j.assigned_staff_id, 'assignedStaffName', s.display_name,
    'hours', jsonb_build_object('travel', j.hours_travel, 'shoot', j.hours_shoot, 'edit', j.hours_edit, 'admin', j.hours_admin),
    'deliveredAt', j.delivered_at, 'tourUrl', j.tour_url, 'notes', j.notes,
    'industry', j.industry, 'clientType', j.client_type, 'source', j.source,
    'leadName', l.first_name, 'createdAt', j.created_at, 'updatedAt', j.updated_at, 'closedAt', j.closed_at,
    'costsTotal', COALESCE((SELECT sum(c.amount) FROM qe_job_costs c WHERE c.job_id = j.id), 0),
    'costs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'amount', c.amount, 'createdAt', c.created_at,
        'createdByName', cs.display_name) ORDER BY c.created_at)
      FROM qe_job_costs c LEFT JOIN qe_staff cs ON cs.user_id = c.created_by WHERE c.job_id = j.id
    ), '[]'::jsonb),
    'payments', COALESCE((
      SELECT jsonb_agg(qe_pay_row(p.id) ORDER BY p.created_at)
      FROM qe_payments p WHERE p.job_id = j.id AND p.status = 'success'
    ), '[]'::jsonb)
  )
  FROM qe_jobs j
  JOIN qe_quotes q ON q.id = j.quote_id
  LEFT JOIN qe_leads l ON l.id = j.lead_id
  LEFT JOIN qe_staff s ON s.user_id = j.assigned_staff_id
  WHERE j.id = p_id
$$;

-- ── Paying ───────────────────────────────────────────────────────────────

-- A payment the client is about to make. The backend works out the amount
-- from the stored quote; this checks it again, so a price can't be changed
-- on the way.
CREATE OR REPLACE FUNCTION public.qe_pay_create(p JSONB, p_today DATE)
RETURNS UUID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_q    qe_quotes%ROWTYPE;
  v_o    qe_quote_options%ROWTYPE;
  v_j    qe_jobs%ROWTYPE;
  v_id   UUID;
  v_kind TEXT := p ->> 'kind';
BEGIN
  SELECT * INTO v_q FROM qe_quotes WHERE id = (p ->> 'quoteId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;

  IF v_kind = 'deposit' THEN
    IF v_q.status NOT IN ('sent', 'viewed') THEN RAISE EXCEPTION 'qe:not_payable'; END IF;
    IF v_q.valid_until IS NOT NULL AND v_q.valid_until < p_today THEN RAISE EXCEPTION 'qe:expired'; END IF;
    IF EXISTS (SELECT 1 FROM qe_jobs j JOIN qe_quotes x ON x.id = j.quote_id WHERE x.request_id = v_q.request_id AND j.status <> 'cancelled') THEN
      RAISE EXCEPTION 'qe:already_booked';
    END IF;
    SELECT * INTO v_o FROM qe_quote_options WHERE quote_id = v_q.id AND tier = p ->> 'tier';
    IF NOT FOUND THEN RAISE EXCEPTION 'qe:no_option'; END IF;
    -- A range or a line still to be confirmed: staff confirm the price first
    IF v_q.result_mode = 'range' OR (v_o.total_high IS NOT NULL AND v_o.total_high <> v_o.total)
       OR EXISTS (SELECT 1 FROM qe_quote_lines WHERE option_id = v_o.id AND tbc) THEN
      RAISE EXCEPTION 'qe:not_final';
    END IF;
    IF v_o.deposit <> (p ->> 'amount')::int OR v_o.deposit <= 0 THEN RAISE EXCEPTION 'qe:amount_mismatch'; END IF;
  ELSIF v_kind = 'balance' THEN
    SELECT * INTO v_j FROM qe_jobs WHERE id = (p ->> 'jobId')::uuid AND quote_id = v_q.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
    IF v_j.balance_status <> 'pending' OR v_j.status = 'cancelled' THEN RAISE EXCEPTION 'qe:balance_closed'; END IF;
    IF v_j.balance_amount <> (p ->> 'amount')::int OR v_j.balance_amount <= 0 THEN RAISE EXCEPTION 'qe:amount_mismatch'; END IF;
  ELSE
    RAISE EXCEPTION 'qe:bad_kind';
  END IF;

  -- Paystack needs an email. A client who left none on the form gives one now;
  -- it is kept so the receipt and the confirmation can reach them.
  IF NULLIF(p ->> 'email', '') IS NOT NULL THEN
    UPDATE qe_leads SET email = p ->> 'email'
    WHERE id = (SELECT lead_id FROM qe_quote_requests WHERE id = v_q.request_id) AND email IS NULL;
  END IF;

  INSERT INTO qe_payments (quote_id, job_id, kind, provider, reference, amount, currency, status, tier, link_id, live)
  VALUES (v_q.id, v_j.id, v_kind, 'paystack', p ->> 'reference', (p ->> 'amount')::int, v_q.currency, 'initialized',
          CASE WHEN v_kind = 'deposit' THEN v_o.tier ELSE v_j.tier END,
          NULLIF(p ->> 'linkId', '')::uuid, COALESCE((p ->> 'live')::boolean, false))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.qe_pay_set_url(p_ref TEXT, p_url TEXT)
RETURNS VOID LANGUAGE sql SET search_path = public AS $$
  UPDATE qe_payments SET authorization_url = p_url WHERE reference = p_ref
$$;

CREATE OR REPLACE FUNCTION public.qe_pay_get(p_ref TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT qe_pay_row(id) FROM qe_payments WHERE reference = p_ref
$$;

-- Record a verified payment exactly once. A deposit accepts the quote,
-- books the lead and creates the job; a balance closes what is owed.
-- p_amount is in Paystack's smallest unit (KES cents).
CREATE OR REPLACE FUNCTION public.qe_pay_settle(p_ref TEXT, p_amount BIGINT, p_currency TEXT, p_channel TEXT, p_paid_at TIMESTAMPTZ, p_raw JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_p      qe_payments%ROWTYPE;
  v_q      qe_quotes%ROWTYPE;
  v_o      qe_quote_options%ROWTYPE;
  v_r      qe_quote_requests%ROWTYPE;
  v_l      qe_leads%ROWTYPE;
  v_j      qe_jobs%ROWTYPE;
  v_job    UUID;
  v_inv    UUID;
  v_paid   TIMESTAMPTZ := COALESCE(p_paid_at, now());
  v_unit   INTEGER;
BEGIN
  SELECT * INTO v_p FROM qe_payments WHERE reference = p_ref FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  IF v_p.status = 'success' THEN
    RETURN jsonb_build_object('outcome', 'already', 'kind', v_p.kind, 'paymentId', v_p.id, 'jobId', v_p.job_id, 'quoteId', v_p.quote_id);
  END IF;

  v_unit := CASE WHEN v_p.currency = 'KES' THEN 100 ELSE 1 END;
  IF p_amount <> v_p.amount::bigint * v_unit OR upper(p_currency) <> v_p.currency THEN
    UPDATE qe_payments SET status = 'failed', failure_reason = 'amount_mismatch', raw_event = p_raw, processed_at = now() WHERE id = v_p.id;
    PERFORM qe_desk_audit(NULL, 'payment', v_p.id::text, 'payment_mismatch',
      jsonb_build_object('amount', v_p.amount, 'currency', v_p.currency), jsonb_build_object('paid', p_amount, 'currency', p_currency), NULL);
    RETURN jsonb_build_object('outcome', 'mismatch', 'kind', v_p.kind, 'paymentId', v_p.id, 'quoteId', v_p.quote_id);
  END IF;

  UPDATE qe_payments SET status = 'success', channel = p_channel, paid_at = v_paid, raw_event = p_raw, processed_at = now(), failure_reason = NULL
  WHERE id = v_p.id;

  SELECT * INTO v_q FROM qe_quotes WHERE id = v_p.quote_id FOR UPDATE;
  SELECT * INTO v_r FROM qe_quote_requests WHERE id = v_q.request_id;
  SELECT * INTO v_l FROM qe_leads WHERE id = v_r.lead_id FOR UPDATE;

  IF v_p.kind = 'deposit' THEN
    -- Paid twice (two tabs, or after a staff booking): keep the money on record for a refund
    SELECT j.* INTO v_j FROM qe_jobs j JOIN qe_quotes x ON x.id = j.quote_id
    WHERE x.request_id = v_q.request_id AND j.status <> 'cancelled' FOR UPDATE OF j;
    IF FOUND THEN
      UPDATE qe_payments SET job_id = v_j.id, note = 'Second deposit for a job that was already booked: refund it' WHERE id = v_p.id;
      PERFORM qe_desk_audit(NULL, 'job', v_j.id::text, 'duplicate_deposit', NULL, jsonb_build_object('reference', p_ref, 'amount', v_p.amount), NULL);
      RETURN jsonb_build_object('outcome', 'duplicate', 'kind', 'deposit', 'paymentId', v_p.id, 'jobId', v_j.id, 'quoteId', v_q.id, 'leadId', v_l.id);
    END IF;

    SELECT * INTO v_o FROM qe_quote_options WHERE quote_id = v_q.id AND tier = v_p.tier;
    UPDATE qe_quote_options SET selected = (tier = v_p.tier) WHERE quote_id = v_q.id;
    UPDATE qe_quotes SET status = 'accepted', accepted_at = v_paid, updated_at = now() WHERE id = v_q.id;
    UPDATE qe_quotes SET status = 'superseded', updated_at = now()
    WHERE request_id = v_q.request_id AND id <> v_q.id AND status IN ('draft', 'needs_approval', 'sent', 'viewed');
    PERFORM qe_desk_audit(NULL, 'quote', v_q.id::text, 'accepted', jsonb_build_object('status', v_q.status),
      jsonb_build_object('status', 'accepted', 'tier', v_p.tier, 'version', v_q.version), 'deposit paid');

    IF v_l.id IS NOT NULL AND v_l.stage NOT IN ('booked', 'delivered', 'paid') THEN
      UPDATE qe_leads SET stage = 'booked', last_activity_at = now() WHERE id = v_l.id;
      PERFORM qe_desk_audit(NULL, 'lead', v_l.id::text, 'stage_changed',
        jsonb_build_object('stage', v_l.stage), jsonb_build_object('stage', 'booked'), 'deposit paid');
    END IF;

    INSERT INTO qe_jobs (quote_id, option_id, lead_id, tier, price, currency, deposit_amount, deposit_status, deposit_paid_at,
      balance_amount, balance_status, balance_paid_at, location_text, location_lat, location_lng, industry, client_type, source)
    VALUES (v_q.id, v_o.id, v_l.id, v_p.tier, v_o.total, v_q.currency, v_p.amount, 'paid', v_paid,
      v_o.total - v_p.amount, CASE WHEN v_o.total - v_p.amount <= 0 THEN 'paid' ELSE 'pending' END,
      CASE WHEN v_o.total - v_p.amount <= 0 THEN v_paid END,
      v_r.answers #>> '{location,town}', (v_r.answers #>> '{location,lat}')::numeric, (v_r.answers #>> '{location,lng}')::numeric,
      COALESCE((SELECT substr(f, 10) FROM unnest(v_r.flags) f WHERE f LIKE 'industry:%' LIMIT 1), v_r.module_key),
      v_r.client_type, v_l.source)
    RETURNING id INTO v_job;
    UPDATE qe_jobs SET ref = 'J-' || upper(substr(replace(v_job::text, '-', ''), 1, 6)) WHERE id = v_job;
    UPDATE qe_payments SET job_id = v_job WHERE id = v_p.id;
    PERFORM qe_desk_audit(NULL, 'job', v_job::text, 'created', NULL, qe_job_row(v_job), 'deposit paid');
  ELSE
    SELECT * INTO v_j FROM qe_jobs WHERE id = v_p.job_id FOR UPDATE;
    v_job := v_j.id;
    IF v_j.balance_status <> 'pending' THEN
      UPDATE qe_payments SET note = 'Balance was already settled: refund it' WHERE id = v_p.id;
      PERFORM qe_desk_audit(NULL, 'job', v_job::text, 'duplicate_balance', NULL, jsonb_build_object('reference', p_ref, 'amount', v_p.amount), NULL);
      RETURN jsonb_build_object('outcome', 'duplicate', 'kind', 'balance', 'paymentId', v_p.id, 'jobId', v_job, 'quoteId', v_q.id, 'leadId', v_l.id);
    END IF;
    UPDATE qe_jobs SET balance_status = 'paid', balance_paid_at = v_paid, updated_at = now() WHERE id = v_job;
    IF v_l.id IS NOT NULL AND v_l.stage <> 'lost' THEN
      UPDATE qe_leads SET stage = 'paid', last_activity_at = now() WHERE id = v_l.id;
      PERFORM qe_desk_audit(NULL, 'lead', v_l.id::text, 'stage_changed',
        jsonb_build_object('stage', v_l.stage), jsonb_build_object('stage', 'paid'), 'balance paid');
    END IF;
    PERFORM qe_desk_audit(NULL, 'job', v_job::text, 'balance_paid', NULL, jsonb_build_object('reference', p_ref, 'amount', v_p.amount), NULL);
  END IF;

  INSERT INTO qe_invoices (job_id, payment_id) VALUES (v_job, v_p.id) RETURNING id INTO v_inv;
  RETURN jsonb_build_object('outcome', 'settled', 'kind', v_p.kind, 'paymentId', v_p.id, 'jobId', v_job,
    'quoteId', v_q.id, 'leadId', v_l.id, 'invoiceId', v_inv);
END $$;

CREATE OR REPLACE FUNCTION public.qe_pay_fail(p_ref TEXT, p_status TEXT, p_reason TEXT)
RETURNS VOID LANGUAGE sql SET search_path = public AS $$
  UPDATE qe_payments SET status = p_status, failure_reason = p_reason, processed_at = now()
  WHERE reference = p_ref AND status = 'initialized' AND p_status IN ('failed', 'abandoned')
$$;

CREATE OR REPLACE FUNCTION public.qe_pay_checked(p_ref TEXT)
RETURNS VOID LANGUAGE sql SET search_path = public AS $$
  UPDATE qe_payments SET checks = checks + 1, last_checked_at = now() WHERE reference = p_ref
$$;

-- Payments still waiting: old enough that the client has left Paystack,
-- young enough to still be worth asking about
CREATE OR REPLACE FUNCTION public.qe_pay_pending(p_min_age_s INTEGER, p_max_age_s INTEGER, p_limit INTEGER)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(reference ORDER BY created_at), '[]'::jsonb) FROM (
    SELECT reference, created_at FROM qe_payments
    WHERE status = 'initialized' AND provider = 'paystack'
      AND created_at < now() - make_interval(secs => p_min_age_s)
      AND created_at > now() - make_interval(secs => p_max_age_s)
      AND (last_checked_at IS NULL OR last_checked_at < now() - interval '5 minutes')
    ORDER BY created_at LIMIT p_limit
  ) x
$$;

-- Staff record a balance paid outside Paystack (M-Pesa till, cash, bank)
CREATE OR REPLACE FUNCTION public.qe_pay_manual_balance(p_job UUID, p_actor UUID, p_channel TEXT, p_reference TEXT, p_note TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_j   qe_jobs%ROWTYPE;
  v_l   qe_leads%ROWTYPE;
  v_pid UUID;
  v_inv UUID;
BEGIN
  SELECT * INTO v_j FROM qe_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  IF v_j.balance_status <> 'pending' THEN RAISE EXCEPTION 'qe:balance_closed'; END IF;
  INSERT INTO qe_payments (quote_id, job_id, kind, provider, reference, amount, currency, status, tier, channel, paid_at, processed_at, recorded_by, note)
  VALUES (v_j.quote_id, v_j.id, 'balance', 'manual', 'manual_' || replace(gen_random_uuid()::text, '-', ''), v_j.balance_amount, v_j.currency,
          'success', v_j.tier, p_channel, now(), now(), p_actor, NULLIF(concat_ws(' · ', NULLIF(p_reference, ''), NULLIF(p_note, '')), ''))
  RETURNING id INTO v_pid;
  UPDATE qe_jobs SET balance_status = 'paid', balance_paid_at = now(), updated_at = now() WHERE id = p_job;
  SELECT * INTO v_l FROM qe_leads WHERE id = v_j.lead_id FOR UPDATE;
  IF FOUND AND v_l.stage <> 'lost' THEN
    UPDATE qe_leads SET stage = 'paid', last_activity_at = now() WHERE id = v_l.id;
    PERFORM qe_desk_audit(p_actor, 'lead', v_l.id::text, 'stage_changed', jsonb_build_object('stage', v_l.stage), jsonb_build_object('stage', 'paid'), 'balance paid');
  END IF;
  PERFORM qe_desk_audit(p_actor, 'job', p_job::text, 'balance_paid', NULL,
    jsonb_build_object('channel', p_channel, 'amount', v_j.balance_amount, 'reference', p_reference), p_note);
  INSERT INTO qe_invoices (job_id, payment_id) VALUES (p_job, v_pid) RETURNING id INTO v_inv;
  RETURN jsonb_build_object('outcome', 'settled', 'kind', 'balance', 'paymentId', v_pid, 'jobId', p_job,
    'quoteId', v_j.quote_id, 'leadId', v_j.lead_id, 'invoiceId', v_inv);
END $$;

CREATE OR REPLACE FUNCTION public.qe_invoice_update(p_id UUID, p_status TEXT, p_provider TEXT, p_external TEXT, p_error TEXT)
RETURNS VOID LANGUAGE sql SET search_path = public AS $$
  UPDATE qe_invoices SET status = p_status, provider = p_provider, external_ref = p_external, error = p_error, updated_at = now()
  WHERE id = p_id
$$;

-- ── Jobs ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_job_get(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$ SELECT qe_job_row(p_id) $$;

CREATE OR REPLACE FUNCTION public.qe_job_for_request(p_request UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT qe_job_row(j.id) FROM qe_jobs j JOIN qe_quotes q ON q.id = j.quote_id
  WHERE q.request_id = p_request AND j.status <> 'cancelled'
  ORDER BY j.created_at DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.qe_job_list(p JSONB) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH m AS (
    SELECT j.id, j.shoot_date, j.created_at FROM qe_jobs j LEFT JOIN qe_leads l ON l.id = j.lead_id
    WHERE (p ->> 'status' IS NULL OR j.status = p ->> 'status' OR (p ->> 'status' = 'open' AND j.status NOT IN ('closed', 'cancelled')))
      AND (p ->> 'staffId' IS NULL OR j.assigned_staff_id = (p ->> 'staffId')::uuid)
      AND (p ->> 'from' IS NULL OR j.shoot_date >= (p ->> 'from')::date)
      AND (p ->> 'to' IS NULL OR j.shoot_date <= (p ->> 'to')::date)
      AND (p ->> 'leadId' IS NULL OR j.lead_id = (p ->> 'leadId')::uuid)
      AND (p ->> 'q' IS NULL OR l.first_name ILIKE '%' || (p ->> 'q') || '%' OR j.ref ILIKE '%' || (p ->> 'q') || '%')
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM m),
    'rows', COALESCE((
      SELECT jsonb_agg(qe_job_row(x.id) - 'costs' - 'payments') FROM (
        SELECT id FROM m ORDER BY shoot_date NULLS FIRST, created_at DESC
        LIMIT COALESCE((p ->> 'limit')::int, 50) OFFSET COALESCE((p ->> 'offset')::int, 0)
      ) x
    ), '[]'::jsonb)
  )
$$;

-- Staff edits. Each field is optional; only what is sent changes.
CREATE OR REPLACE FUNCTION public.qe_job_update(p_id UUID, p JSONB, p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_before JSONB;
  v_j      qe_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_j FROM qe_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  IF p ? 'assignedStaffId' AND p ->> 'assignedStaffId' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM qe_staff WHERE user_id = (p ->> 'assignedStaffId')::uuid AND active) THEN
    RAISE EXCEPTION 'qe:owner_not_staff';
  END IF;
  v_before := qe_job_row(p_id) - 'costs' - 'payments';
  UPDATE qe_jobs SET
    status            = COALESCE(p ->> 'status', status),
    shoot_date        = CASE WHEN p ? 'shootDate' THEN (p ->> 'shootDate')::date ELSE shoot_date END,
    shoot_window      = CASE WHEN p ? 'shootWindow' THEN p ->> 'shootWindow' ELSE shoot_window END,
    shoot_date_status = COALESCE(p ->> 'shootDateStatus', shoot_date_status),
    assigned_staff_id = CASE WHEN p ? 'assignedStaffId' THEN (p ->> 'assignedStaffId')::uuid ELSE assigned_staff_id END,
    hours_travel      = COALESCE((p #>> '{hours,travel}')::numeric, hours_travel),
    hours_shoot       = COALESCE((p #>> '{hours,shoot}')::numeric, hours_shoot),
    hours_edit        = COALESCE((p #>> '{hours,edit}')::numeric, hours_edit),
    hours_admin       = COALESCE((p #>> '{hours,admin}')::numeric, hours_admin),
    delivered_at      = CASE WHEN p ? 'deliveredAt' THEN (p ->> 'deliveredAt')::timestamptz ELSE delivered_at END,
    tour_url          = CASE WHEN p ? 'tourUrl' THEN p ->> 'tourUrl' ELSE tour_url END,
    notes             = CASE WHEN p ? 'notes' THEN p ->> 'notes' ELSE notes END,
    closed_at         = CASE WHEN p ->> 'status' = 'closed' AND status <> 'closed' THEN now()
                             WHEN p ? 'status' AND p ->> 'status' <> 'closed' THEN NULL ELSE closed_at END,
    updated_at        = now()
  WHERE id = p_id;
  -- Delivering moves the lead on, unless the balance is already paid
  IF p ->> 'status' = 'delivered' AND v_j.status <> 'delivered' THEN
    UPDATE qe_leads SET stage = 'delivered', last_activity_at = now() WHERE id = v_j.lead_id AND stage IN ('booked', 'quoted', 'contacted', 'new');
    IF FOUND THEN
      PERFORM qe_desk_audit(p_actor, 'lead', v_j.lead_id::text, 'stage_changed', NULL, jsonb_build_object('stage', 'delivered'), 'job delivered');
    END IF;
  END IF;
  PERFORM qe_desk_audit(p_actor, 'job', p_id::text, 'updated', v_before, qe_job_row(p_id) - 'costs' - 'payments', NULL);
  RETURN qe_job_row(p_id);
END $$;

-- The client asks for a slot. Bookings are serialised so two clients can't
-- take the last place in the same slot.
CREATE OR REPLACE FUNCTION public.qe_job_request_date(p_id UUID, p_date DATE, p_window TEXT, p_per_slot INTEGER)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_j qe_jobs%ROWTYPE;
  v_n INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('qe_booking'));
  SELECT * INTO v_j FROM qe_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  IF v_j.shoot_date_status = 'confirmed' OR v_j.status NOT IN ('booked', 'scheduled') THEN RAISE EXCEPTION 'qe:date_locked'; END IF;
  SELECT count(*) INTO v_n FROM qe_jobs
  WHERE shoot_date = p_date AND shoot_window = p_window AND status <> 'cancelled' AND id <> p_id;
  IF v_n >= p_per_slot THEN RAISE EXCEPTION 'qe:slot_full'; END IF;
  UPDATE qe_jobs SET shoot_date = p_date, shoot_window = p_window, shoot_date_status = 'requested', updated_at = now() WHERE id = p_id;
  PERFORM qe_desk_audit(NULL, 'job', p_id::text, 'date_requested',
    jsonb_build_object('shootDate', v_j.shoot_date, 'shootWindow', v_j.shoot_window),
    jsonb_build_object('shootDate', p_date, 'shootWindow', p_window), 'picked by the client');
  RETURN qe_job_row(p_id);
END $$;

CREATE OR REPLACE FUNCTION public.qe_job_add_cost(p_job UUID, p_label TEXT, p_amount INTEGER, p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM qe_jobs WHERE id = p_job) THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  INSERT INTO qe_job_costs (job_id, label, amount, created_by) VALUES (p_job, p_label, p_amount, p_actor) RETURNING id INTO v_id;
  PERFORM qe_desk_audit(p_actor, 'job', p_job::text, 'cost_added', NULL, jsonb_build_object('label', p_label, 'amount', p_amount), NULL);
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'amount', p_amount, 'createdAt', now());
END $$;

CREATE OR REPLACE FUNCTION public.qe_job_delete_cost(p_job UUID, p_cost UUID, p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_c qe_job_costs%ROWTYPE;
BEGIN
  DELETE FROM qe_job_costs WHERE id = p_cost AND job_id = p_job RETURNING * INTO v_c;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  PERFORM qe_desk_audit(p_actor, 'job', p_job::text, 'cost_removed', jsonb_build_object('label', v_c.label, 'amount', v_c.amount), NULL, NULL);
END $$;

CREATE OR REPLACE FUNCTION public.qe_booking_counts(p_from DATE, p_to DATE)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', to_char(shoot_date, 'YYYY-MM-DD'), 'window', shoot_window, 'n', n)), '[]'::jsonb)
  FROM (
    SELECT shoot_date, shoot_window, count(*) AS n FROM qe_jobs
    WHERE shoot_date BETWEEN p_from AND p_to AND shoot_window IS NOT NULL AND status <> 'cancelled'
    GROUP BY shoot_date, shoot_window
  ) x
$$;

CREATE OR REPLACE FUNCTION public.qe_settings_get(p_key TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$ SELECT value FROM qe_settings WHERE key = p_key $$;

CREATE OR REPLACE FUNCTION public.qe_settings_set(p_key TEXT, p_value JSONB, p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_before JSONB;
BEGIN
  SELECT value INTO v_before FROM qe_settings WHERE key = p_key FOR UPDATE;
  INSERT INTO qe_settings (key, value, updated_by, updated_at) VALUES (p_key, p_value, p_actor, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM qe_desk_audit(p_actor, 'settings', p_key, 'updated', v_before, p_value, NULL);
END $$;

-- ── Only the service role (the backend) may call these ───────────────────
DO $$
DECLARE
  f TEXT;
  r TEXT;
  fns TEXT[] := ARRAY[
    'qe_pay_row(UUID)', 'qe_job_row(UUID)',
    'qe_pay_create(JSONB, DATE)', 'qe_pay_set_url(TEXT, TEXT)', 'qe_pay_get(TEXT)',
    'qe_pay_settle(TEXT, BIGINT, TEXT, TEXT, TIMESTAMPTZ, JSONB)', 'qe_pay_fail(TEXT, TEXT, TEXT)',
    'qe_pay_checked(TEXT)', 'qe_pay_pending(INTEGER, INTEGER, INTEGER)',
    'qe_pay_manual_balance(UUID, UUID, TEXT, TEXT, TEXT)', 'qe_invoice_update(UUID, TEXT, TEXT, TEXT, TEXT)',
    'qe_job_get(UUID)', 'qe_job_for_request(UUID)', 'qe_job_list(JSONB)', 'qe_job_update(UUID, JSONB, UUID)',
    'qe_job_request_date(UUID, DATE, TEXT, INTEGER)', 'qe_job_add_cost(UUID, TEXT, INTEGER, UUID)',
    'qe_job_delete_cost(UUID, UUID, UUID)', 'qe_booking_counts(DATE, DATE)',
    'qe_settings_get(TEXT)', 'qe_settings_set(TEXT, JSONB, UUID)'
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
