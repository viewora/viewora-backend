-- Quote engine, migration 003: admin lead list and new-lead alerts.
--   * Who-are-you answers gain 'marketer' (marketing agency) and 'other'.
--   * The staff new-lead alert email becomes an editable template.
--   * Read-only functions the admin's lead list, lead page and summary call.
-- Requires migrations 001 and 002. Run in the Supabase SQL editor.
-- Rollback: migration-quote-engine-003.down.sql

BEGIN;

ALTER TABLE public.qe_quote_requests DROP CONSTRAINT IF EXISTS qe_quote_requests_client_type_check;
ALTER TABLE public.qe_quote_requests ADD CONSTRAINT qe_quote_requests_client_type_check
  CHECK (client_type IN ('owner', 'agent', 'developer', 'manager', 'marketer', 'other'));

-- Staff alert wording. Edit the row (or add version 2) to change it; no code change needed.
INSERT INTO public.qe_message_templates (key, channel, locale, version, subject, body)
VALUES (
  'staff_new_lead', 'email', 'en', 1,
  'New quote lead: {{name}}, {{industry}}',
  E'A new lead just came in from the quote form.\n\nName: {{name}}\nIndustry: {{industry}}\nWho they are: {{client_type}}\nSource: {{source}}\n\nOpen the lead: {{admin_link}}'
)
ON CONFLICT DO NOTHING;

-- ── Lead list ────────────────────────────────────────────────────────────
-- One row per lead with its latest request and that request's latest quote.
-- Filters are optional; p_q matches first name, email or phone digits.
CREATE OR REPLACE FUNCTION public.qe_admin_leads(
  p_stage    TEXT    DEFAULT NULL,
  p_industry TEXT    DEFAULT NULL,
  p_source   TEXT    DEFAULT NULL,
  p_status   TEXT    DEFAULT NULL,   -- 'completed' | 'abandoned'
  p_q        TEXT    DEFAULT NULL,
  p_limit    INTEGER DEFAULT 50,
  p_offset   INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_text   TEXT := NULLIF(btrim(p_q), '');
  v_like   TEXT;
  v_digits TEXT;
  v_result JSONB;
BEGIN
  IF v_text IS NOT NULL THEN
    -- Typed text is matched literally: escape LIKE wildcards
    v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := NULLIF(regexp_replace(v_text, '\D', '', 'g'), '');
    -- A Kenyan number typed as 07... is stored as +2547...
    IF v_digits LIKE '0%' THEN v_digits := '254' || substr(v_digits, 2); END IF;
  END IF;

  WITH base AS (
    SELECT
      l.id, l.first_name, l.whatsapp_e164, l.email, l.source, l.stage, l.created_at, l.last_activity_at,
      l.consent_whatsapp, l.opted_out_at,
      r.id AS request_id, r.module_key, r.client_type, r.step_reached, r.flags, r.completed_at,
      GREATEST(l.last_activity_at, r.last_saved_at) AS activity_at,
      COALESCE(
        (SELECT substr(f, 10) FROM unnest(r.flags) AS f WHERE f LIKE 'industry:%' LIMIT 1),
        r.module_key
      ) AS industry
    FROM qe_leads l
    LEFT JOIN LATERAL (
      SELECT * FROM qe_quote_requests x WHERE x.lead_id = l.id ORDER BY x.last_saved_at DESC LIMIT 1
    ) r ON true
    WHERE l.deleted_at IS NULL
  ),
  filtered AS (
    SELECT * FROM base b
    WHERE (p_stage IS NULL OR b.stage = p_stage)
      AND (p_source IS NULL OR b.source = p_source)
      AND (p_industry IS NULL OR b.industry = p_industry)
      AND (p_status IS NULL
           OR (p_status = 'completed' AND b.completed_at IS NOT NULL)
           OR (p_status = 'abandoned' AND b.completed_at IS NULL))
      AND (v_text IS NULL
           OR b.first_name ILIKE v_like
           OR b.email ILIKE v_like
           OR (v_digits IS NOT NULL AND b.whatsapp_e164 LIKE '%' || v_digits || '%'))
  ),
  page AS (
    SELECT f.*, q.result_mode, q.total, q.total_high
    FROM filtered f
    LEFT JOIN LATERAL (
      SELECT qq.result_mode, o.total, o.total_high
      FROM qe_quotes qq
      LEFT JOIN LATERAL (
        SELECT oo.total, oo.total_high FROM qe_quote_options oo
        WHERE oo.quote_id = qq.id
        ORDER BY (oo.tier = 'standard') DESC, oo.total ASC
        LIMIT 1
      ) o ON true
      WHERE qq.request_id = f.request_id
      ORDER BY qq.created_at DESC
      LIMIT 1
    ) q ON true
    ORDER BY f.activity_at DESC, f.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM filtered),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'leadId', p.id,
        'requestId', p.request_id,
        'firstName', p.first_name,
        'whatsapp', p.whatsapp_e164,
        'email', p.email,
        'source', p.source,
        'stage', p.stage,
        'industry', p.industry,
        'moduleKey', p.module_key,
        'clientType', p.client_type,
        'stepReached', COALESCE(p.step_reached, 0),
        'completed', p.completed_at IS NOT NULL,
        'flags', COALESCE(to_jsonb(p.flags), '[]'::jsonb),
        'optedOut', p.opted_out_at IS NOT NULL,
        'createdAt', p.created_at,
        'lastActivityAt', p.activity_at,
        'mode', p.result_mode,
        'total', p.total,
        'totalHigh', p.total_high
      ) ORDER BY p.activity_at DESC, p.id)
      FROM page p
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $$;

-- ── One lead ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.qe_admin_lead(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'lead', jsonb_build_object(
      'id', l.id, 'firstName', l.first_name, 'whatsapp', l.whatsapp_e164, 'email', l.email,
      'source', l.source, 'utm', l.utm, 'stage', l.stage,
      'consentWhatsapp', l.consent_whatsapp, 'consentEmail', l.consent_email, 'consentAt', l.consent_at,
      'consentText', c.body, 'optedOutAt', l.opted_out_at,
      'createdAt', l.created_at, 'lastActivityAt', l.last_activity_at
    ),
    'requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'moduleKey', r.module_key, 'moduleVersion', r.module_version, 'clientType', r.client_type,
        'answers', COALESCE(r.answers -> 'answers', '{}'::jsonb), 'entry', COALESCE(r.answers -> 'entry', '{}'::jsonb),
        'stepReached', r.step_reached, 'flags', to_jsonb(r.flags), 'abVariant', r.ab_variant,
        'startedAt', r.started_at, 'lastSavedAt', r.last_saved_at, 'completedAt', r.completed_at,
        'quotes', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', q.id, 'mode', q.result_mode, 'status', q.status, 'currency', q.currency,
            'vatCharged', q.vat_charged, 'depositBp', q.deposit_bp, 'validUntil', q.valid_until,
            'createdAt', q.created_at,
            'warnings', COALESCE(q.engine_trace -> 'warnings', '[]'::jsonb),
            'options', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'tier', o.tier, 'subtotal', o.subtotal, 'discount', o.discount, 'net', o.net, 'vat', o.vat,
                'total', o.total, 'totalHigh', o.total_high, 'deposit', o.deposit, 'selected', o.selected,
                'lines', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'kind', li.kind, 'label', li.label, 'qty', li.quantity, 'unit', li.unit_price,
                    'amount', li.amount, 'tbc', li.tbc, 'note', li.note
                  ) ORDER BY li.position)
                  FROM qe_quote_lines li WHERE li.option_id = o.id
                ), '[]'::jsonb)
              ) ORDER BY array_position(ARRAY['essential', 'standard', 'premium', 'estimate', 'draft'], o.tier))
              FROM qe_quote_options o WHERE o.quote_id = q.id
            ), '[]'::jsonb)
          ) ORDER BY q.created_at DESC)
          FROM qe_quotes q WHERE q.request_id = r.id
        ), '[]'::jsonb)
      ) ORDER BY r.last_saved_at DESC)
      FROM qe_quote_requests r WHERE r.lead_id = l.id
    ), '[]'::jsonb),
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'channel', m.channel, 'templateKey', m.template_key, 'status', m.status,
        'skipReason', m.skip_reason, 'error', m.error, 'sentAt', m.sent_at, 'createdAt', m.created_at
      ) ORDER BY m.created_at DESC)
      FROM qe_messages m WHERE m.lead_id = l.id
    ), '[]'::jsonb),
    'notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'authorId', n.author_id, 'createdAt', n.created_at)
        ORDER BY n.created_at DESC)
      FROM qe_notes n WHERE n.lead_id = l.id
    ), '[]'::jsonb)
  )
  FROM qe_leads l
  LEFT JOIN qe_consent_texts c ON c.id = l.consent_text_id
  WHERE l.id = p_id AND l.deleted_at IS NULL
$$;

-- ── Summary strip and filter choices ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.qe_admin_summary() RETURNS JSONB
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH today AS (
    -- Midnight in Nairobi, as a timestamp
    SELECT (date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi')) AT TIME ZONE 'Africa/Nairobi' AS start
  )
  SELECT jsonb_build_object(
    'newToday', (SELECT count(*) FROM qe_leads, today WHERE deleted_at IS NULL AND created_at >= today.start),
    'leads7d', (SELECT count(*) FROM qe_leads WHERE deleted_at IS NULL AND created_at >= now() - interval '7 days'),
    'completed7d', (SELECT count(*) FROM qe_quote_requests WHERE completed_at >= now() - interval '7 days'),
    -- Requests that stopped before step 2 leave no contact, so they are counted, not listed
    'noContact7d', (SELECT count(*) FROM qe_quote_requests WHERE lead_id IS NULL AND started_at >= now() - interval '7 days'),
    'abandonedByStep', COALESCE((
      SELECT jsonb_object_agg(step_reached::text, n) FROM (
        SELECT step_reached, count(*) AS n FROM qe_quote_requests
        WHERE completed_at IS NULL AND started_at >= now() - interval '30 days'
        GROUP BY step_reached
      ) s
    ), '{}'::jsonb),
    'sources', COALESCE((SELECT jsonb_agg(DISTINCT source ORDER BY source) FROM qe_leads WHERE source IS NOT NULL AND deleted_at IS NULL), '[]'::jsonb),
    'industries', COALESCE((
      SELECT jsonb_agg(DISTINCT i ORDER BY i) FROM (
        SELECT COALESCE((SELECT substr(f, 10) FROM unnest(flags) AS f WHERE f LIKE 'industry:%' LIMIT 1), module_key) AS i
        FROM qe_quote_requests WHERE lead_id IS NOT NULL
      ) x WHERE i IS NOT NULL
    ), '[]'::jsonb)
  )
$$;

-- ── Who gets the new-lead email ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.qe_alert_recipients() RETURNS SETOF TEXT
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT u.email::text FROM qe_staff s JOIN auth.users u ON u.id = s.user_id
  WHERE s.active AND s.alert_new_leads AND u.email IS NOT NULL
$$;

-- Only the backend (service role) may call these. Supabase grants new
-- functions to anon and authenticated by default, so take that back.
REVOKE ALL ON FUNCTION public.qe_admin_leads(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.qe_admin_lead(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.qe_admin_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.qe_alert_recipients() FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.qe_admin_leads(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.qe_admin_lead(UUID) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.qe_admin_summary() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.qe_alert_recipients() FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.qe_admin_leads(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO service_role;
    GRANT EXECUTE ON FUNCTION public.qe_admin_lead(UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION public.qe_admin_summary() TO service_role;
    GRANT EXECUTE ON FUNCTION public.qe_alert_recipients() TO service_role;
  END IF;
END $$;

COMMIT;
