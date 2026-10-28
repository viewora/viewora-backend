-- Quote engine, migration 006: follow-ups (Phase 4a).
--   * qe_sequences (from 001) gains what the runner needs: the quote or job
--     it follows, when it (re)started, and one active sequence per lead and
--     kind.
--   * qe_messages (from 001) gains the step that sent it and WhatsApp
--     to-dos: staff press send in their own WhatsApp (click-to-chat), so a
--     due WhatsApp step waits as a queued message until someone does.
--   * qe_resume_tokens: extra "finish your quote" links for reminders. The
--     visitor's own token is only stored hashed, so a reminder carries a
--     new token; only its hash is kept here too.
--   * qe_settings 'messaging': weekly cap (3), high-value alert (off) and the
--     review link (none yet).
--   * Wording for every follow-up and the high-value staff alert.
--   * Functions for claiming due sequences, stopping them, saving a new
--     template version and opting a lead out. Each writes qe_audit_log.
-- Only qe_* tables are touched. Requires migrations 001-005.
-- Rollback: migration-quote-engine-006.down.sql

BEGIN;

-- ── Sequences ────────────────────────────────────────────────────────────
ALTER TABLE public.qe_sequences
  ADD COLUMN IF NOT EXISTS subject_id  UUID,                 -- the quote or job it follows
  ADD COLUMN IF NOT EXISTS started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS stopped_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS qe_sequences_active_uidx ON public.qe_sequences(lead_id, sequence_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS qe_sequences_due_idx ON public.qe_sequences(next_run_at) WHERE status = 'active';

-- ── Messages: the step, and WhatsApp to-dos ──────────────────────────────
ALTER TABLE public.qe_messages
  ADD COLUMN IF NOT EXISTS sequence_step TEXT,
  ADD COLUMN IF NOT EXISTS needs_staff   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS done_by       UUID REFERENCES public.qe_staff(user_id),
  ADD COLUMN IF NOT EXISTS done_at       TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS qe_messages_tasks_idx ON public.qe_messages(created_at) WHERE status = 'queued' AND needs_staff;
CREATE INDEX IF NOT EXISTS qe_messages_week_idx ON public.qe_messages(lead_id, created_at) WHERE sequence_id IS NOT NULL;

-- ── Extra resume links ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qe_resume_tokens (
  token_hash         TEXT PRIMARY KEY,
  request_id         UUID        NOT NULL REFERENCES public.qe_quote_requests(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL
);
ALTER TABLE public.qe_resume_tokens ENABLE ROW LEVEL SECURITY;

-- ── Settings ─────────────────────────────────────────────────────────────
INSERT INTO public.qe_settings (key, value) VALUES
  ('messaging', '{"weeklyCap": 3, "highValueAmount": null, "highValueEmails": [], "reviewUrl": null}')
ON CONFLICT DO NOTHING;

-- ── Wording (editable in the admin; each save is a new version) ──────────
INSERT INTO public.qe_message_templates (key, channel, locale, version, subject, body) VALUES
('abandoned_resume', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, this is Viewora. You started a quote for {{industry}} but did not get to the price. Your answers are saved, so it takes about a minute to finish:\n{{resume_link}}\n\nOr just reply here and we will price it for you.'),
('abandoned_resume', 'email', 'en', 1, 'Your Viewora quote is saved',
  E'Hi {{name}},\n\nYou started a quote for {{industry}} yesterday. Your answers are saved, and the price is about a minute away:\n{{resume_link}}\n\nIf it is easier, reply to this email and we will work it out with you.\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('quote_ready', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, here is your Viewora quote for {{industry}}: {{quote_link}}\n\n{{amount}}, valid until {{valid_until}}. You can pay the deposit and pick a shoot day on that page, or reply here with any questions.'),
('quote_ready', 'email', 'en', 1, 'Your Viewora quote: {{amount}}',
  E'Hi {{name}},\n\nThank you for asking about a Viewora tour for {{industry}}. Your quote is here:\n{{quote_link}}\n\n{{amount}}, valid until {{valid_until}}. You can pay the deposit and pick a shoot day on that page.\n\nReply to this email if you would like anything changed.\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('quote_nudge', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, just checking you got your Viewora quote for {{industry}}: {{quote_link}}\n\nHappy to answer any questions here.'),
('quote_nudge', 'email', 'en', 1, 'Did you see your Viewora quote?',
  E'Hi {{name}},\n\nJust checking you got your quote for {{industry}} ({{amount}}):\n{{quote_link}}\n\nReply if you have any questions.\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('quote_adjust', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, is there anything we should adjust on your quote? We can change the package, the extras or the shoot day: {{quote_link}}'),
('quote_adjust', 'email', 'en', 1, 'Anything we should adjust?',
  E'Hi {{name}},\n\nIs there anything we should change on your quote for {{industry}}? We can adjust the package, the extras or the timing.\n{{quote_link}}\n\nJust reply to this email.\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('quote_expiry', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, your Viewora quote ({{amount}}) is valid until {{valid_until}}. To keep this price, pay the deposit here: {{quote_link}}'),
('quote_expiry', 'email', 'en', 1, 'Your Viewora quote expires {{valid_until}}',
  E'Hi {{name}},\n\nYour quote for {{industry}} ({{amount}}) is valid until {{valid_until}}. To keep this price, pay the deposit and pick a day here:\n{{quote_link}}\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('review_request', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, thank you for working with Viewora. If you are happy with your tour, a short Google review helps us a lot: {{review_link}}'),
('review_request', 'email', 'en', 1, 'How did we do?',
  E'Hi {{name}},\n\nThank you for working with Viewora. Your tour is here: {{tour_link}}\n\nIf you are happy with it, a short Google review helps other clients find us:\n{{review_link}}\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('hosting_offer', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, your Viewora tour has been live for two weeks: {{tour_link}}\n\nIf you would like to keep adding tours yourself, ask us about a Viewora plan.'),
('hosting_offer', 'email', 'en', 1, 'Keep your tour working for you',
  E'Hi {{name}},\n\nYour tour has been live for two weeks: {{tour_link}}\n\nIf you would like to edit it, add more spaces or host more tours, reply and we will show you the Viewora plans.\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('renewal_reminder', 'whatsapp', 'en', 1, NULL,
  E'Hi {{name}}, the hosting for your Viewora tour renews next month: {{tour_link}}\n\nReply here to renew, or to ask about refreshing the tour with new photos.'),
('renewal_reminder', 'email', 'en', 1, 'Your tour hosting renews next month',
  E'Hi {{name}},\n\nThe hosting for your Viewora tour renews next month:\n{{tour_link}}\n\nReply to renew, or to ask about a refresh shoot if anything has changed.\n\nThe Viewora team\n\nDo not want these emails? {{optout_link}}'),
('staff_high_value', 'email', 'en', 1, 'High-value lead: {{name}}, {{amount}}',
  E'A form quote came in at {{amount}} for {{industry}} (source: {{source}}).\n\nOpen the lead: {{admin_link}}')
ON CONFLICT DO NOTHING;

-- ── Functions ────────────────────────────────────────────────────────────

-- Hands out up to p_limit due sequences and leases them for 5 minutes, so
-- two backend instances never run the same step twice
CREATE OR REPLACE FUNCTION public.qe_fu_claim(p_now TIMESTAMPTZ, p_limit INTEGER)
RETURNS SETOF public.qe_sequences LANGUAGE sql SET search_path = public AS $$
  UPDATE qe_sequences s SET next_run_at = p_now + interval '5 minutes', updated_at = now()
  WHERE s.id IN (
    SELECT id FROM qe_sequences
    WHERE status = 'active' AND next_run_at <= p_now
    ORDER BY next_run_at LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING s.*;
$$;

-- Starts a sequence, replacing any active one of the same kind for the lead
CREATE OR REPLACE FUNCTION public.qe_fu_start(p_lead UUID, p_key TEXT, p_subject UUID, p_step SMALLINT, p_run TIMESTAMPTZ, p_started TIMESTAMPTZ)
RETURNS UUID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE qe_sequences SET status = 'stopped', stop_reason = 'restarted', stopped_at = now(), updated_at = now()
  WHERE lead_id = p_lead AND sequence_key = p_key AND status = 'active';
  INSERT INTO qe_sequences (lead_id, sequence_key, subject_id, next_step, next_run_at, started_at)
  VALUES (p_lead, p_key, p_subject, p_step, p_run, p_started) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Stops active sequences (all, or the kinds given) and drops their unsent
-- WhatsApp to-dos. Returns how many stopped.
CREATE OR REPLACE FUNCTION public.qe_fu_stop(p_lead UUID, p_reason TEXT, p_keys TEXT[], p_actor UUID)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ids UUID[];
BEGIN
  WITH s AS (
    UPDATE qe_sequences SET status = 'stopped', stop_reason = p_reason, stopped_at = now(), updated_at = now()
    WHERE lead_id = p_lead AND status = 'active' AND (p_keys IS NULL OR sequence_key = ANY(p_keys))
    RETURNING id
  ) SELECT array_agg(id) INTO v_ids FROM s;
  IF v_ids IS NULL THEN RETURN 0; END IF;
  UPDATE qe_messages SET status = 'skipped', skip_reason = 'stopped'
  WHERE sequence_id = ANY(v_ids) AND status = 'queued';
  PERFORM qe_desk_audit(p_actor, 'lead', p_lead::text, 'followups_stopped', NULL,
    jsonb_build_object('reason', p_reason, 'count', array_length(v_ids, 1)), NULL);
  RETURN array_length(v_ids, 1);
END $$;

-- An inbound WhatsApp from a lead's number: stop everything for them
CREATE OR REPLACE FUNCTION public.qe_fu_replied(p_e164 TEXT)
RETURNS UUID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_lead UUID;
BEGIN
  SELECT id INTO v_lead FROM qe_leads WHERE whatsapp_e164 = p_e164 AND deleted_at IS NULL;
  IF v_lead IS NULL THEN RETURN NULL; END IF;
  UPDATE qe_leads SET last_activity_at = now() WHERE id = v_lead;
  PERFORM qe_fu_stop(v_lead, 'replied', NULL, NULL);
  RETURN v_lead;
END $$;

-- Saves wording as a new version (the old ones stay for history and rollback)
CREATE OR REPLACE FUNCTION public.qe_tpl_save(p_key TEXT, p_channel TEXT, p_subject TEXT, p_body TEXT, p_actor UUID)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_version INTEGER;
  v_before  JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('qe_tpl:' || p_key || ':' || p_channel));
  SELECT jsonb_build_object('version', version, 'subject', subject, 'body', body), version INTO v_before, v_version
  FROM qe_message_templates WHERE key = p_key AND channel = p_channel AND locale = 'en'
  ORDER BY version DESC LIMIT 1;
  v_version := COALESCE(v_version, 0) + 1;
  INSERT INTO qe_message_templates (key, channel, locale, version, subject, body, updated_by, updated_at)
  VALUES (p_key, p_channel, 'en', v_version, p_subject, p_body, p_actor, now());
  PERFORM qe_desk_audit(p_actor, 'template', p_key || ':' || p_channel, 'saved', v_before,
    jsonb_build_object('version', v_version, 'subject', p_subject, 'body', p_body), NULL);
  RETURN v_version;
END $$;

-- The lead asked to stop (link in an email, or staff on their behalf)
CREATE OR REPLACE FUNCTION public.qe_fu_opt_out(p_lead UUID, p_actor UUID, p_via TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_was TIMESTAMPTZ;
BEGIN
  SELECT opted_out_at INTO v_was FROM qe_leads WHERE id = p_lead AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_was IS NULL THEN
    UPDATE qe_leads SET opted_out_at = now(), consent_whatsapp = false, consent_email = false WHERE id = p_lead;
    PERFORM qe_desk_audit(p_actor, 'lead', p_lead::text, 'opted_out', NULL, jsonb_build_object('via', p_via), NULL);
  END IF;
  PERFORM qe_fu_stop(p_lead, 'opted_out', NULL, p_actor);
  RETURN true;
END $$;

-- ── Only the service role (the backend) may call these ───────────────────
DO $$
DECLARE
  f TEXT;
  r TEXT;
  fns TEXT[] := ARRAY[
    'qe_fu_claim(TIMESTAMPTZ, INTEGER)', 'qe_fu_start(UUID, TEXT, UUID, SMALLINT, TIMESTAMPTZ, TIMESTAMPTZ)',
    'qe_fu_stop(UUID, TEXT, TEXT[], UUID)', 'qe_fu_replied(TEXT)',
    'qe_tpl_save(TEXT, TEXT, TEXT, TEXT, UUID)', 'qe_fu_opt_out(UUID, UUID, TEXT)'
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
