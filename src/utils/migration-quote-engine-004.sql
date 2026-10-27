-- Quote engine, migration 004: quotes staff build and send (Phase 2).
--   * Quote statuses gain 'needs_approval' (discount over a person's limit)
--     and 'superseded' (a newer version was sent). Quotes gain a note for
--     the client.
--   * qe_quote_links: the links sent to clients. Only a SHA-256 hash of
--     each link's token is stored, and every link has an expiry.
--   * Messages can point at the quote they carried.
--   * Editable wording for sending a quote by WhatsApp and by email.
--   * Functions the admin calls to build, approve and send quotes, run the
--     lead board and edit the rate table. Each one runs as one transaction
--     and writes qe_audit_log for every change to a quote, lead or price.
-- Only qe_* tables (all created by migration 001) are touched.
-- Requires migrations 001-003. Run in the Supabase SQL editor.
-- Rollback: migration-quote-engine-004.down.sql

BEGIN;

ALTER TABLE public.qe_quotes DROP CONSTRAINT IF EXISTS qe_quotes_status_check;
ALTER TABLE public.qe_quotes ADD CONSTRAINT qe_quotes_status_check
  CHECK (status IN ('draft', 'needs_approval', 'sent', 'viewed', 'accepted', 'expired', 'lost', 'superseded'));
ALTER TABLE public.qe_quotes ADD COLUMN IF NOT EXISTS client_note TEXT;
ALTER TABLE public.qe_quotes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.qe_messages ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES public.qe_quotes(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.qe_quote_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           UUID        NOT NULL REFERENCES public.qe_quotes(id) ON DELETE CASCADE,
  token_hash         TEXT        NOT NULL UNIQUE,   -- sha256; the raw token only lives in the link
  channel            TEXT        NOT NULL CHECK (channel IN ('link', 'whatsapp', 'email')),
  created_by         UUID REFERENCES public.qe_staff(user_id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  first_viewed_at    TIMESTAMPTZ,
  last_viewed_at     TIMESTAMPTZ,
  views              INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS qe_quote_links_quote_idx ON public.qe_quote_links(quote_id);
ALTER TABLE public.qe_quote_links ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS qe_leads_owner_idx ON public.qe_leads(owner_staff_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS qe_quotes_request_idx ON public.qe_quotes(request_id, version DESC);

-- Wording for sending a quote. Edit the row (or add version 2) to change it.
INSERT INTO public.qe_message_templates (key, channel, locale, version, subject, body) VALUES
(
  'quote_link', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, here is your Viewora quote for {{industry}}: {{quote_link}}\n\n{{amount}}, valid until {{valid_until}}. Reply here if you have any questions.\n\n{{staff_name}}, Viewora'
),
(
  'quote_link', 'email', 'en', 1,
  'Your Viewora quote: {{amount}}',
  E'Hi {{name}},\n\nThank you for asking about a Viewora tour for {{industry}}. Your quote is attached as a PDF, and you can also open it here:\n{{quote_link}}\n\n{{amount}}, valid until {{valid_until}}.\n\nReply to this email or WhatsApp us if you would like anything changed.\n\n{{staff_name}}, Viewora'
)
ON CONFLICT DO NOTHING;

-- ── Helpers ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_desk_audit(p_actor UUID, p_type TEXT, p_id TEXT, p_action TEXT, p_before JSONB, p_after JSONB, p_reason TEXT)
RETURNS VOID LANGUAGE sql SET search_path = public AS $$
  INSERT INTO qe_audit_log (actor_id, entity_type, entity_id, action, before, after, reason)
  VALUES (p_actor, p_type, p_id, p_action, p_before, p_after, p_reason)
$$;

-- A quote as the TypeScript QuoteDoc (camelCase JSON)
CREATE OR REPLACE FUNCTION public.qe_desk_quote(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', q.id, 'requestId', q.request_id, 'leadId', r.lead_id, 'version', q.version,
    'supersedesId', q.supersedes_id, 'status', q.status, 'mode', q.result_mode, 'currency', q.currency,
    'vatCharged', q.vat_charged, 'vatRateBp', q.vat_rate_bp, 'depositBp', q.deposit_bp,
    'validUntil', to_char(q.valid_until, 'YYYY-MM-DD'),
    'discountReason', q.discount_reason, 'discountApprovedBy', q.discount_approved_by,
    'clientNote', q.client_note, 'rateTableId', q.rate_table_id, 'rateTableVersion', t.version,
    'createdBy', q.created_by, 'createdAt', q.created_at, 'sentAt', q.sent_at, 'viewedAt', q.viewed_at,
    'baseline', COALESCE(q.engine_trace -> 'baseline', '{}'::jsonb),
    'warnings', COALESCE(q.engine_trace -> 'warnings', '[]'::jsonb),
    -- The engine output, for quotes the form made (staff edits have none)
    'trace', CASE WHEN q.engine_trace ? 'options' THEN q.engine_trace END,
    'options', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'tier', o.tier, 'selected', o.selected,
        'subtotal', o.subtotal, 'discount', o.discount,
        'discountBp', CASE WHEN o.subtotal = 0 THEN 0 ELSE round(o.discount * 10000.0 / o.subtotal)::int END,
        'net', o.net, 'vat', o.vat, 'total', o.total, 'deposit', o.deposit,
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'key', li.rate_item_key, 'kind', li.kind, 'label', li.label, 'qty', li.quantity,
            'unit', li.unit_price, 'amount', li.amount, 'tbc', li.tbc, 'note', li.note
          ) ORDER BY li.position)
          FROM qe_quote_lines li WHERE li.option_id = o.id
        ), '[]'::jsonb)
      ) ORDER BY array_position(ARRAY['essential', 'standard', 'premium', 'estimate', 'draft'], o.tier))
      FROM qe_quote_options o WHERE o.quote_id = q.id
    ), '[]'::jsonb)
  )
  FROM qe_quotes q
  JOIN qe_quote_requests r ON r.id = q.request_id
  JOIN qe_rate_tables t ON t.id = q.rate_table_id
  WHERE q.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.qe_desk_lead(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', l.id, 'firstName', l.first_name, 'whatsappE164', l.whatsapp_e164, 'email', l.email,
    'stage', l.stage, 'ownerStaffId', l.owner_staff_id, 'optedOutAt', l.opted_out_at
  )
  FROM qe_leads l WHERE l.id = p_id AND l.deleted_at IS NULL
$$;

-- ── Staff ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_desk_staff(p_user UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object('userId', s.user_id, 'displayName', s.display_name, 'role', s.role,
    'discountLimitBp', s.discount_limit_bp, 'email', u.email)
  FROM qe_staff s LEFT JOIN auth.users u ON u.id = s.user_id
  WHERE s.user_id = p_user AND s.active
$$;

CREATE OR REPLACE FUNCTION public.qe_desk_staff_list() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('userId', s.user_id, 'displayName', s.display_name, 'role', s.role,
    'discountLimitBp', s.discount_limit_bp, 'email', u.email) ORDER BY s.display_name), '[]'::jsonb)
  FROM qe_staff s LEFT JOIN auth.users u ON u.id = s.user_id
  WHERE s.active
$$;

-- ── Requests ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_desk_latest_request(p_lead UUID) RETURNS UUID
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT id FROM qe_quote_requests WHERE lead_id = p_lead ORDER BY last_saved_at DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.qe_desk_request(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'leadId', r.lead_id, 'moduleKey', r.module_key, 'clientType', r.client_type,
    'flags', COALESCE(to_jsonb(r.flags), '[]'::jsonb),
    'answers', COALESCE(r.answers -> 'answers', '{"details":{},"addons":{}}'::jsonb),
    'latestQuoteId', (SELECT q.id FROM qe_quotes q WHERE q.request_id = r.id ORDER BY q.version DESC LIMIT 1)
  )
  FROM qe_quote_requests r WHERE r.id = p_id
$$;

-- ── Saving a quote ───────────────────────────────────────────────────────
-- Inserts a new version (p_doc.id null) or replaces an editable draft.
-- Totals arrive already computed by the TypeScript desk rules.

CREATE OR REPLACE FUNCTION public.qe_desk_save_quote(p_doc JSONB, p_trace JSONB, p_actor UUID, p_action TEXT, p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_id      UUID := NULLIF(p_doc ->> 'id', '')::uuid;
  v_request UUID := (p_doc ->> 'requestId')::uuid;
  v_status  TEXT := p_doc ->> 'status';
  v_before  JSONB;
  v_version INTEGER;
  v_option  JSONB;
  v_line    JSONB;
  v_opt_id  UUID;
  v_pos     INTEGER;
  v_trace   JSONB := jsonb_build_object('baseline', COALESCE(p_doc -> 'baseline', '{}'::jsonb), 'warnings', COALESCE(p_doc -> 'warnings', '[]'::jsonb));
BEGIN
  IF v_id IS NULL THEN
    -- Lock the request so two saves can't take the same version number
    PERFORM 1 FROM qe_quote_requests WHERE id = v_request FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
    SELECT COALESCE(max(version), 0) + 1 INTO v_version FROM qe_quotes WHERE request_id = v_request;
    INSERT INTO qe_quotes (
      request_id, rate_table_id, version, supersedes_id, result_mode, currency, vat_charged, vat_rate_bp,
      discount_reason, discount_approved_by, deposit_bp, valid_until, status, engine_trace, created_by,
      client_note, sent_at
    ) VALUES (
      v_request, (p_doc ->> 'rateTableId')::uuid, v_version, NULLIF(p_doc ->> 'supersedesId', '')::uuid,
      p_doc ->> 'mode', COALESCE(p_doc ->> 'currency', 'KES'), (p_doc ->> 'vatCharged')::boolean,
      (p_doc ->> 'vatRateBp')::int, p_doc ->> 'discountReason', NULLIF(p_doc ->> 'discountApprovedBy', '')::uuid,
      (p_doc ->> 'depositBp')::int, NULLIF(p_doc ->> 'validUntil', '')::date, v_status,
      COALESCE(p_trace, v_trace), p_actor, p_doc ->> 'clientNote',
      CASE WHEN v_status = 'sent' THEN now() END
    ) RETURNING id INTO v_id;
  ELSE
    SELECT status INTO v_status FROM qe_quotes WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
    IF v_status NOT IN ('draft', 'needs_approval') THEN RAISE EXCEPTION 'qe:locked'; END IF;
    v_before := qe_desk_quote(v_id) - 'trace';
    UPDATE qe_quotes SET
      status = p_doc ->> 'status',
      currency = COALESCE(p_doc ->> 'currency', currency),
      vat_charged = (p_doc ->> 'vatCharged')::boolean,
      deposit_bp = (p_doc ->> 'depositBp')::int,
      valid_until = NULLIF(p_doc ->> 'validUntil', '')::date,
      discount_reason = p_doc ->> 'discountReason',
      discount_approved_by = NULLIF(p_doc ->> 'discountApprovedBy', '')::uuid,
      client_note = p_doc ->> 'clientNote',
      engine_trace = COALESCE(engine_trace, '{}'::jsonb) || v_trace,
      updated_at = now()
    WHERE id = v_id;
    DELETE FROM qe_quote_options WHERE quote_id = v_id;   -- lines go with them
  END IF;

  FOR v_option IN SELECT * FROM jsonb_array_elements(COALESCE(p_doc -> 'options', '[]'::jsonb)) LOOP
    INSERT INTO qe_quote_options (quote_id, tier, subtotal, discount, net, vat, total, total_high, deposit, selected)
    VALUES (v_id, v_option ->> 'tier', (v_option ->> 'subtotal')::int, (v_option ->> 'discount')::int,
      (v_option ->> 'net')::int, (v_option ->> 'vat')::int, (v_option ->> 'total')::int,
      NULLIF(v_option ->> 'totalHigh', '')::int, (v_option ->> 'deposit')::int, COALESCE((v_option ->> 'selected')::boolean, false))
    RETURNING id INTO v_opt_id;
    v_pos := 0;
    FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(v_option -> 'lines', '[]'::jsonb)) LOOP
      INSERT INTO qe_quote_lines (option_id, position, rate_item_key, kind, label, quantity, unit_price, amount, tbc, note)
      VALUES (v_opt_id, v_pos, NULLIF(v_line ->> 'key', ''), v_line ->> 'kind', v_line ->> 'label',
        (v_line ->> 'qty')::int, (v_line ->> 'unit')::int, (v_line ->> 'amount')::int,
        COALESCE((v_line ->> 'tbc')::boolean, false), v_line ->> 'note');
      v_pos := v_pos + 1;
    END LOOP;
  END LOOP;

  -- Quotes the form makes are not staff changes; everything else is audited
  IF p_actor IS NOT NULL THEN
    PERFORM qe_desk_audit(p_actor, 'quote', v_id::text, p_action, v_before, qe_desk_quote(v_id) - 'trace', p_reason);
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.qe_desk_decide_approval(p_id UUID, p_actor UUID, p_approve BOOLEAN, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_before JSONB;
BEGIN
  PERFORM 1 FROM qe_quotes WHERE id = p_id AND status = 'needs_approval' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_waiting'; END IF;
  v_before := qe_desk_quote(p_id) - 'trace';
  UPDATE qe_quotes SET status = 'draft', discount_approved_by = CASE WHEN p_approve THEN p_actor END, updated_at = now()
  WHERE id = p_id;
  PERFORM qe_desk_audit(p_actor, 'quote', p_id::text, CASE WHEN p_approve THEN 'discount_approved' ELSE 'discount_rejected' END,
    v_before, qe_desk_quote(p_id) - 'trace', p_reason);
END $$;

-- ── Sending ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_desk_mark_sent(p_id UUID, p_actor UUID, p_token_hash TEXT, p_channel TEXT, p_expires TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_q     qe_quotes%ROWTYPE;
  v_lead  qe_leads%ROWTYPE;
  v_after TEXT;
BEGIN
  SELECT * INTO v_q FROM qe_quotes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  IF v_q.status = 'needs_approval' THEN RAISE EXCEPTION 'qe:needs_approval'; END IF;
  IF v_q.status NOT IN ('draft', 'sent', 'viewed') THEN RAISE EXCEPTION 'qe:locked'; END IF;

  v_after := CASE WHEN v_q.status = 'draft' THEN 'sent' ELSE v_q.status END;
  UPDATE qe_quotes SET status = v_after, sent_at = COALESCE(sent_at, now()), updated_at = now() WHERE id = p_id;

  -- The client's older copies say they were replaced
  UPDATE qe_quotes SET status = 'superseded', updated_at = now()
  WHERE request_id = v_q.request_id AND id <> p_id AND version < v_q.version AND status IN ('sent', 'viewed');

  SELECT l.* INTO v_lead FROM qe_leads l JOIN qe_quote_requests r ON r.lead_id = l.id WHERE r.id = v_q.request_id FOR UPDATE OF l;
  IF FOUND AND v_lead.stage IN ('new', 'contacted') THEN
    UPDATE qe_leads SET stage = 'quoted' WHERE id = v_lead.id;
    PERFORM qe_desk_audit(p_actor, 'lead', v_lead.id::text, 'stage_changed',
      jsonb_build_object('stage', v_lead.stage), jsonb_build_object('stage', 'quoted'), 'quote sent');
  END IF;

  INSERT INTO qe_quote_links (quote_id, token_hash, channel, created_by, expires_at)
  VALUES (p_id, p_token_hash, p_channel, p_actor, p_expires);

  PERFORM qe_desk_audit(p_actor, 'quote', p_id::text, 'sent_' || p_channel,
    jsonb_build_object('status', v_q.status), jsonb_build_object('status', v_after), NULL);
END $$;

CREATE OR REPLACE FUNCTION public.qe_desk_find_link(p_token_hash TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'linkId', k.id, 'expiresAt', k.expires_at, 'revoked', k.revoked_at IS NOT NULL,
    'quote', qe_desk_quote(q.id),
    'lead', qe_desk_lead(r.lead_id),
    'moduleKey', r.module_key,
    'flags', COALESCE(to_jsonb(r.flags), '[]'::jsonb),
    'replacedAt', CASE WHEN q.status = 'superseded' THEN COALESCE(
      (SELECT n.sent_at FROM qe_quotes n WHERE n.request_id = q.request_id AND n.version > q.version AND n.sent_at IS NOT NULL
       ORDER BY n.version LIMIT 1), q.updated_at) END
  )
  FROM qe_quote_links k
  JOIN qe_quotes q ON q.id = k.quote_id
  JOIN qe_quote_requests r ON r.id = q.request_id
  WHERE k.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION public.qe_desk_link_seen(p_link UUID) RETURNS JSONB
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_quote UUID;
  v_first BOOLEAN;
BEGIN
  UPDATE qe_quote_links SET views = views + 1, first_viewed_at = COALESCE(first_viewed_at, now()), last_viewed_at = now()
  WHERE id = p_link RETURNING quote_id INTO v_quote;
  IF v_quote IS NULL THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  SELECT viewed_at IS NULL INTO v_first FROM qe_quotes WHERE id = v_quote FOR UPDATE;
  UPDATE qe_quotes SET viewed_at = COALESCE(viewed_at, now()),
    status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
  WHERE id = v_quote;
  UPDATE qe_leads SET last_activity_at = now()
  WHERE id = (SELECT r.lead_id FROM qe_quotes q JOIN qe_quote_requests r ON r.id = q.request_id WHERE q.id = v_quote);
  RETURN jsonb_build_object('firstView', v_first);
END $$;

CREATE OR REPLACE FUNCTION public.qe_desk_quote_lost(p_id UUID, p_actor UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM qe_quotes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  IF v_status IN ('accepted', 'lost', 'superseded') THEN RAISE EXCEPTION 'qe:locked'; END IF;
  UPDATE qe_quotes SET status = 'lost', updated_at = now() WHERE id = p_id;
  PERFORM qe_desk_audit(p_actor, 'quote', p_id::text, 'marked_lost',
    jsonb_build_object('status', v_status), jsonb_build_object('status', 'lost'), p_reason);
END $$;

-- ── Leads: stage, owner, notes ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_desk_update_lead(p_id UUID, p_patch JSONB, p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_lead  qe_leads%ROWTYPE;
  v_owner UUID;
BEGIN
  SELECT * INTO v_lead FROM qe_leads WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;

  IF p_patch ? 'stage' AND p_patch ->> 'stage' IS DISTINCT FROM v_lead.stage THEN
    UPDATE qe_leads SET stage = p_patch ->> 'stage' WHERE id = p_id;
    PERFORM qe_desk_audit(p_actor, 'lead', p_id::text, 'stage_changed',
      jsonb_build_object('stage', v_lead.stage), jsonb_build_object('stage', p_patch ->> 'stage'), NULL);
  END IF;

  IF p_patch ? 'ownerStaffId' THEN
    v_owner := NULLIF(p_patch ->> 'ownerStaffId', '')::uuid;
    IF v_owner IS DISTINCT FROM v_lead.owner_staff_id THEN
      IF v_owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qe_staff WHERE user_id = v_owner AND active) THEN
        RAISE EXCEPTION 'qe:owner_not_staff';
      END IF;
      UPDATE qe_leads SET owner_staff_id = v_owner WHERE id = p_id;
      PERFORM qe_desk_audit(p_actor, 'lead', p_id::text, 'owner_changed',
        jsonb_build_object('ownerStaffId', v_lead.owner_staff_id), jsonb_build_object('ownerStaffId', v_owner), NULL);
    END IF;
  END IF;

  RETURN qe_desk_lead(p_id);
END $$;

CREATE OR REPLACE FUNCTION public.qe_desk_add_note(p_lead UUID, p_actor UUID, p_body TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_note qe_notes%ROWTYPE;
BEGIN
  PERFORM 1 FROM qe_leads WHERE id = p_lead AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  INSERT INTO qe_notes (lead_id, author_id, body) VALUES (p_lead, p_actor, p_body) RETURNING * INTO v_note;
  RETURN jsonb_build_object('id', v_note.id, 'createdAt', v_note.created_at);
END $$;

-- ── Rate tables ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.qe_rt_meta(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', t.id, 'version', t.version, 'status', t.status, 'effectiveFrom', to_char(t.effective_from, 'YYYY-MM-DD'),
    'notes', t.notes, 'publishedAt', t.published_at, 'publishedBy', t.published_by,
    'publishedByName', s.display_name, 'createdAt', t.created_at
  )
  FROM qe_rate_tables t LEFT JOIN qe_staff s ON s.user_id = t.published_by
  WHERE t.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.qe_rt_list() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(qe_rt_meta(id) ORDER BY version DESC), '[]'::jsonb) FROM qe_rate_tables
$$;

-- Items in the shape of the TypeScript RateItem (as the public form loads them)
CREATE OR REPLACE FUNCTION public.qe_rt_get(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT qe_rt_meta(t.id) || jsonb_build_object(
    'settings', t.settings,
    'items', COALESCE((
      SELECT jsonb_object_agg(i.key,
        jsonb_build_object('key', i.key, 'category', i.category, 'label', i.label, 'unit', i.unit,
          'low', i.amount_low, 'high', i.amount_high, 'use', i.use_value)
        || jsonb_strip_nulls(jsonb_build_object('industry', i.industry, 'custom', CASE WHEN i.custom THEN true END,
          'scenes', i.scenes, 'tiers', i.tiers, 'meta', CASE WHEN i.meta <> '{}'::jsonb THEN i.meta END)))
      FROM qe_rate_items i WHERE i.rate_table_id = t.id
    ), '{}'::jsonb)
  )
  FROM qe_rate_tables t WHERE t.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.qe_rt_create_draft(p_from UUID, p_actor UUID)
RETURNS UUID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_from qe_rate_tables%ROWTYPE;
  v_id   UUID;
  v_ver  INTEGER;
BEGIN
  LOCK TABLE qe_rate_tables IN SHARE ROW EXCLUSIVE MODE;   -- one draft at a time
  IF EXISTS (SELECT 1 FROM qe_rate_tables WHERE status = 'draft') THEN RAISE EXCEPTION 'qe:draft_exists'; END IF;
  SELECT * INTO v_from FROM qe_rate_tables WHERE id = p_from;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  SELECT max(version) + 1 INTO v_ver FROM qe_rate_tables;
  INSERT INTO qe_rate_tables (version, status, effective_from, settings)
  VALUES (v_ver, 'draft', (now() AT TIME ZONE 'Africa/Nairobi')::date, v_from.settings)
  RETURNING id INTO v_id;
  INSERT INTO qe_rate_items (rate_table_id, key, category, label, industry, unit, amount_low, amount_high, use_value, custom, scenes, tiers, meta)
  SELECT v_id, key, category, label, industry, unit, amount_low, amount_high, use_value, custom, scenes, tiers, meta
  FROM qe_rate_items WHERE rate_table_id = p_from;
  PERFORM qe_desk_audit(p_actor, 'rate_table', v_id::text, 'draft_created', NULL,
    jsonb_build_object('fromVersion', v_from.version, 'version', v_ver), NULL);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.qe_rt_update_item(p_id UUID, p_key TEXT, p_patch JSONB, p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_ver  INTEGER;
  v_item qe_rate_items%ROWTYPE;
BEGIN
  SELECT version INTO v_ver FROM qe_rate_tables WHERE id = p_id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_draft'; END IF;
  SELECT * INTO v_item FROM qe_rate_items WHERE rate_table_id = p_id AND key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_found'; END IF;
  UPDATE qe_rate_items SET
    label       = CASE WHEN p_patch ? 'label' THEN p_patch ->> 'label' ELSE label END,
    amount_low  = CASE WHEN p_patch ? 'low'   THEN (p_patch ->> 'low')::int ELSE amount_low END,
    amount_high = CASE WHEN p_patch ? 'high'  THEN (p_patch ->> 'high')::int ELSE amount_high END,
    use_value   = CASE WHEN p_patch ? 'use'   THEN p_patch ->> 'use' ELSE use_value END
  WHERE rate_table_id = p_id AND key = p_key;
  PERFORM qe_desk_audit(p_actor, 'rate_item', v_ver || ':' || p_key, 'updated',
    jsonb_build_object('label', v_item.label, 'low', v_item.amount_low, 'high', v_item.amount_high, 'use', v_item.use_value),
    (SELECT jsonb_build_object('label', label, 'low', amount_low, 'high', amount_high, 'use', use_value)
     FROM qe_rate_items WHERE rate_table_id = p_id AND key = p_key), NULL);
END $$;

CREATE OR REPLACE FUNCTION public.qe_rt_update_settings(p_id UUID, p_settings JSONB, p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_before JSONB;
BEGIN
  SELECT settings INTO v_before FROM qe_rate_tables WHERE id = p_id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_draft'; END IF;
  UPDATE qe_rate_tables SET settings = p_settings WHERE id = p_id;
  PERFORM qe_desk_audit(p_actor, 'rate_table', p_id::text, 'settings_updated', v_before, p_settings, NULL);
END $$;

-- Publishing archives the current table. Sent quotes keep the version they
-- were built on (qe_quotes.rate_table_id), so their prices never change.
CREATE OR REPLACE FUNCTION public.qe_rt_publish(p_id UUID, p_actor UUID, p_notes TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ver INTEGER;
BEGIN
  SELECT version INTO v_ver FROM qe_rate_tables WHERE id = p_id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_draft'; END IF;
  UPDATE qe_rate_tables SET status = 'archived' WHERE status = 'published';
  UPDATE qe_rate_tables SET status = 'published', published_at = now(), published_by = p_actor, notes = p_notes,
    effective_from = (now() AT TIME ZONE 'Africa/Nairobi')::date
  WHERE id = p_id;
  PERFORM qe_desk_audit(p_actor, 'rate_table', p_id::text, 'published', NULL, jsonb_build_object('version', v_ver), p_notes);
END $$;

CREATE OR REPLACE FUNCTION public.qe_rt_delete_draft(p_id UUID, p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ver INTEGER;
BEGIN
  SELECT version INTO v_ver FROM qe_rate_tables WHERE id = p_id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qe:not_draft'; END IF;
  DELETE FROM qe_rate_tables WHERE id = p_id;   -- items go with it
  PERFORM qe_desk_audit(p_actor, 'rate_table', p_id::text, 'draft_deleted', jsonb_build_object('version', v_ver), NULL, NULL);
END $$;

CREATE OR REPLACE FUNCTION public.qe_rt_open_quotes(p_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT count(*)::int FROM qe_quotes WHERE rate_table_id = p_id AND status IN ('draft', 'needs_approval', 'sent', 'viewed')
$$;

-- ── Lead list and lead page, version 2 ───────────────────────────────────
-- Same as migration 003's functions plus owner, quote status and approvals.
-- (003's versions stay in place, so rolling back 004 needs no rewrite.)

CREATE OR REPLACE FUNCTION public.qe_admin_leads_v2(
  p_stage    TEXT    DEFAULT NULL,
  p_industry TEXT    DEFAULT NULL,
  p_source   TEXT    DEFAULT NULL,
  p_status   TEXT    DEFAULT NULL,   -- 'completed' | 'abandoned'
  p_q        TEXT    DEFAULT NULL,
  p_limit    INTEGER DEFAULT 50,
  p_offset   INTEGER DEFAULT 0,
  p_owner    TEXT    DEFAULT NULL    -- staff uuid, or 'none' for unassigned
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
    v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := NULLIF(regexp_replace(v_text, '\D', '', 'g'), '');
    IF v_digits LIKE '0%' THEN v_digits := '254' || substr(v_digits, 2); END IF;
  END IF;

  WITH base AS (
    SELECT
      l.id, l.first_name, l.whatsapp_e164, l.email, l.source, l.stage, l.created_at, l.last_activity_at,
      l.consent_whatsapp, l.opted_out_at, l.owner_staff_id, s.display_name AS owner_name,
      r.id AS request_id, r.module_key, r.client_type, r.step_reached, r.flags, r.completed_at,
      GREATEST(l.last_activity_at, r.last_saved_at) AS activity_at,
      COALESCE(
        (SELECT substr(f, 10) FROM unnest(r.flags) AS f WHERE f LIKE 'industry:%' LIMIT 1),
        r.module_key
      ) AS industry
    FROM qe_leads l
    LEFT JOIN qe_staff s ON s.user_id = l.owner_staff_id
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
      AND (p_owner IS NULL
           OR (p_owner = 'none' AND b.owner_staff_id IS NULL)
           OR b.owner_staff_id::text = p_owner)
      AND (p_status IS NULL
           OR (p_status = 'completed' AND b.completed_at IS NOT NULL)
           OR (p_status = 'abandoned' AND b.completed_at IS NULL))
      AND (v_text IS NULL
           OR b.first_name ILIKE v_like
           OR b.email ILIKE v_like
           OR (v_digits IS NOT NULL AND b.whatsapp_e164 LIKE '%' || v_digits || '%'))
  ),
  page AS (
    SELECT f.*, q.result_mode, q.status AS quote_status, q.total, q.total_high,
      EXISTS (SELECT 1 FROM qe_quotes w JOIN qe_quote_requests wr ON wr.id = w.request_id
              WHERE wr.lead_id = f.id AND w.status = 'needs_approval') AS needs_approval
    FROM filtered f
    LEFT JOIN LATERAL (
      SELECT qq.result_mode, qq.status, o.total, o.total_high
      FROM qe_quotes qq
      LEFT JOIN LATERAL (
        SELECT oo.total, oo.total_high FROM qe_quote_options oo
        WHERE oo.quote_id = qq.id
        ORDER BY oo.selected DESC, (oo.tier = 'standard') DESC, oo.total ASC
        LIMIT 1
      ) o ON true
      WHERE qq.request_id = f.request_id
      ORDER BY qq.version DESC
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
        'quoteStatus', p.quote_status,
        'needsApproval', p.needs_approval,
        'ownerId', p.owner_staff_id,
        'ownerName', p.owner_name,
        'total', p.total,
        'totalHigh', p.total_high
      ) ORDER BY p.activity_at DESC, p.id)
      FROM page p
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.qe_admin_lead_v2(p_id UUID) RETURNS JSONB
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'lead', jsonb_build_object(
      'id', l.id, 'firstName', l.first_name, 'whatsapp', l.whatsapp_e164, 'email', l.email,
      'source', l.source, 'utm', l.utm, 'stage', l.stage,
      'ownerId', l.owner_staff_id, 'ownerName', os.display_name,
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
            'id', q.id, 'version', q.version, 'supersedesId', q.supersedes_id,
            'mode', q.result_mode, 'status', q.status, 'currency', q.currency,
            'vatCharged', q.vat_charged, 'depositBp', q.deposit_bp, 'validUntil', to_char(q.valid_until, 'YYYY-MM-DD'),
            'discountReason', q.discount_reason, 'clientNote', q.client_note,
            'createdAt', q.created_at, 'sentAt', q.sent_at, 'viewedAt', q.viewed_at,
            'createdByName', cs.display_name,
            'links', (SELECT jsonb_build_object('count', count(*), 'views', COALESCE(sum(k.views), 0), 'lastViewedAt', max(k.last_viewed_at))
                      FROM qe_quote_links k WHERE k.quote_id = q.id),
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
          ) ORDER BY q.version DESC)
          FROM qe_quotes q LEFT JOIN qe_staff cs ON cs.user_id = q.created_by
          WHERE q.request_id = r.id
        ), '[]'::jsonb)
      ) ORDER BY r.last_saved_at DESC)
      FROM qe_quote_requests r WHERE r.lead_id = l.id
    ), '[]'::jsonb),
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'channel', m.channel, 'templateKey', m.template_key, 'status', m.status, 'quoteId', m.quote_id,
        'skipReason', m.skip_reason, 'error', m.error, 'sentAt', m.sent_at, 'createdAt', m.created_at
      ) ORDER BY m.created_at DESC)
      FROM qe_messages m WHERE m.lead_id = l.id
    ), '[]'::jsonb),
    'notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'authorId', n.author_id, 'authorName', ns.display_name, 'createdAt', n.created_at)
        ORDER BY n.created_at DESC)
      FROM qe_notes n LEFT JOIN qe_staff ns ON ns.user_id = n.author_id WHERE n.lead_id = l.id
    ), '[]'::jsonb),
    -- Staff changes to this lead and its quotes, newest first
    'activity', COALESCE((
      SELECT jsonb_agg(x.item ORDER BY x.at DESC) FROM (
        SELECT a.created_at AS at, jsonb_build_object('id', a.id, 'entityType', a.entity_type, 'entityId', a.entity_id,
          'action', a.action, 'actorName', au.display_name, 'before', a.before, 'after', a.after,
          'reason', a.reason, 'createdAt', a.created_at) AS item
        FROM qe_audit_log a LEFT JOIN qe_staff au ON au.user_id = a.actor_id
        WHERE (a.entity_type = 'lead' AND a.entity_id = l.id::text)
           OR (a.entity_type = 'quote' AND a.entity_id IN (
                SELECT q.id::text FROM qe_quotes q JOIN qe_quote_requests r ON r.id = q.request_id WHERE r.lead_id = l.id))
        ORDER BY a.created_at DESC
        LIMIT 100
      ) x
    ), '[]'::jsonb)
  )
  FROM qe_leads l
  LEFT JOIN qe_consent_texts c ON c.id = l.consent_text_id
  LEFT JOIN qe_staff os ON os.user_id = l.owner_staff_id
  WHERE l.id = p_id AND l.deleted_at IS NULL
$$;

-- ── Only the service role (the backend) may call these ───────────────────
DO $$
DECLARE
  f TEXT;
  r TEXT;
  fns TEXT[] := ARRAY[
    'qe_desk_audit(UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT)',
    'qe_desk_quote(UUID)', 'qe_desk_lead(UUID)', 'qe_desk_staff(UUID)', 'qe_desk_staff_list()',
    'qe_desk_latest_request(UUID)', 'qe_desk_request(UUID)',
    'qe_desk_save_quote(JSONB, JSONB, UUID, TEXT, TEXT)', 'qe_desk_decide_approval(UUID, UUID, BOOLEAN, TEXT)',
    'qe_desk_mark_sent(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ)', 'qe_desk_find_link(TEXT)', 'qe_desk_link_seen(UUID)',
    'qe_desk_quote_lost(UUID, UUID, TEXT)', 'qe_desk_update_lead(UUID, JSONB, UUID)', 'qe_desk_add_note(UUID, UUID, TEXT)',
    'qe_rt_meta(UUID)', 'qe_rt_list()', 'qe_rt_get(UUID)', 'qe_rt_create_draft(UUID, UUID)',
    'qe_rt_update_item(UUID, TEXT, JSONB, UUID)', 'qe_rt_update_settings(UUID, JSONB, UUID)',
    'qe_rt_publish(UUID, UUID, TEXT)', 'qe_rt_delete_draft(UUID, UUID)', 'qe_rt_open_quotes(UUID)',
    'qe_admin_leads_v2(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT)', 'qe_admin_lead_v2(UUID)'
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
