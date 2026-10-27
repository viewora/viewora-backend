-- Quote engine, migration 001: leads, quote requests, rate tables, quotes,
-- jobs, payments, partners, messages, staff and audit.
-- Rollback: migration-quote-engine-001.down.sql
--
-- Only NEW tables (prefix qe_); no existing table is changed.
-- Money: integer whole KES, or integer USD cents when currency = 'USD'.
-- Percentages: basis points (1600 = 16%).
--
-- RLS is enabled on every table with NO policies: only the backend's
-- service role can read or write. The public anon key cannot see leads.
-- Run in the Supabase SQL editor.

BEGIN;

CREATE TABLE public.qe_staff (
  user_id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name       TEXT        NOT NULL,
  role               TEXT        NOT NULL CHECK (role IN ('admin', 'sales', 'viewer')),
  discount_limit_bp  INTEGER     NOT NULL DEFAULT 0 CHECK (discount_limit_bp BETWEEN 0 AND 10000),
  whatsapp_e164      TEXT,
  alert_new_leads    BOOLEAN     NOT NULL DEFAULT false,
  alert_high_value   BOOLEAN     NOT NULL DEFAULT false,
  active             BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_partners (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL,
  code               TEXT        NOT NULL UNIQUE,
  commission_type    TEXT        NOT NULL CHECK (commission_type IN ('percent', 'fixed')),
  commission_value   INTEGER     NOT NULL CHECK (commission_value >= 0),  -- bp or KES
  active             BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exact consent wording shown to the visitor, so every lead points at the text they agreed to.
CREATE TABLE public.qe_consent_texts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locale             TEXT        NOT NULL DEFAULT 'en',
  body               TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_leads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name         TEXT,
  whatsapp_e164      TEXT,
  email              TEXT,
  consent_whatsapp   BOOLEAN     NOT NULL DEFAULT false,
  consent_email      BOOLEAN     NOT NULL DEFAULT false,
  consent_at         TIMESTAMPTZ,
  consent_text_id    UUID REFERENCES public.qe_consent_texts(id),
  source             TEXT,                       -- instagram, tiktok, youtube, whatsapp, site, app...
  utm                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  partner_id         UUID REFERENCES public.qe_partners(id),
  owner_staff_id     UUID REFERENCES public.qe_staff(user_id),
  user_id            UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- logged-in app users
  stage              TEXT        NOT NULL DEFAULT 'new'
                       CHECK (stage IN ('new', 'contacted', 'quoted', 'booked', 'delivered', 'paid', 'lost')),
  opted_out_at       TIMESTAMPTZ,
  last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ                 -- personal fields are blanked on deletion/retention
);
CREATE UNIQUE INDEX qe_leads_whatsapp_uidx ON public.qe_leads(whatsapp_e164) WHERE whatsapp_e164 IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX qe_leads_stage_idx ON public.qe_leads(stage, last_activity_at DESC);

CREATE TABLE public.qe_rate_tables (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version            INTEGER     NOT NULL UNIQUE,
  status             TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  effective_from     DATE        NOT NULL,
  settings           JSONB       NOT NULL,       -- VAT, discount cap, deposit, USD rate, validity, origin
  notes              TEXT,
  published_by       UUID REFERENCES public.qe_staff(user_id),
  published_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one published table at a time.
CREATE UNIQUE INDEX qe_rate_tables_one_published ON public.qe_rate_tables((status)) WHERE status = 'published';

CREATE TABLE public.qe_rate_items (
  rate_table_id      UUID        NOT NULL REFERENCES public.qe_rate_tables(id) ON DELETE CASCADE,
  key                TEXT        NOT NULL,
  category           TEXT        NOT NULL CHECK (category IN ('base', 'addon', 'uplift', 'discount', 'travel', 'hosting', 'plan_cap', 'minimum')),
  label              TEXT        NOT NULL,
  industry           TEXT,
  unit               TEXT        NOT NULL,
  amount_low         INTEGER,                    -- NULL = custom, no published price
  amount_high        INTEGER,
  use_value          TEXT        NOT NULL DEFAULT 'low' CHECK (use_value IN ('low', 'high')),
  custom             BOOLEAN     NOT NULL DEFAULT false,
  scenes             INTEGER,
  tiers              JSONB,
  meta               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (rate_table_id, key)
);

CREATE TABLE public.qe_entry_links (
  code               TEXT PRIMARY KEY,           -- the /q/:code short link
  prefill            JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- name, industry, town, source
  lead_id            UUID REFERENCES public.qe_leads(id) ON DELETE SET NULL,
  created_by         UUID REFERENCES public.qe_staff(user_id),
  uses               INTEGER     NOT NULL DEFAULT 0,
  max_uses           INTEGER,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_quote_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID REFERENCES public.qe_leads(id) ON DELETE CASCADE,
  module_key         TEXT,
  module_version     INTEGER,
  client_type        TEXT CHECK (client_type IN ('owner', 'agent', 'developer', 'manager')),
  answers            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  step_reached       SMALLINT    NOT NULL DEFAULT 0,
  resume_token_hash  TEXT        NOT NULL UNIQUE,  -- sha256; the raw token only ever lives in the link
  entry_link_code    TEXT REFERENCES public.qe_entry_links(code) ON DELETE SET NULL,
  ab_variant         TEXT,
  flags              TEXT[]      NOT NULL DEFAULT '{}',  -- new_industry, ...
  device             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_saved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX qe_quote_requests_lead_idx ON public.qe_quote_requests(lead_id);
CREATE INDEX qe_quote_requests_abandoned_idx ON public.qe_quote_requests(last_saved_at) WHERE completed_at IS NULL;

CREATE TABLE public.qe_quotes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         UUID        NOT NULL REFERENCES public.qe_quote_requests(id) ON DELETE CASCADE,
  rate_table_id      UUID        NOT NULL REFERENCES public.qe_rate_tables(id),
  version            INTEGER     NOT NULL DEFAULT 1,
  supersedes_id      UUID REFERENCES public.qe_quotes(id),  -- an edit to a sent quote is a new row
  result_mode        TEXT        NOT NULL CHECK (result_mode IN ('instant', 'range', 'custom')),
  currency           TEXT        NOT NULL DEFAULT 'KES' CHECK (currency IN ('KES', 'USD')),
  fx_rate            NUMERIC(10, 4),
  vat_charged        BOOLEAN     NOT NULL,
  vat_rate_bp        INTEGER     NOT NULL,
  discount_reason    TEXT,
  discount_approved_by UUID REFERENCES public.qe_staff(user_id),
  deposit_bp         INTEGER     NOT NULL DEFAULT 5000,
  valid_until        DATE,
  status             TEXT        NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'expired', 'lost')),
  public_token_hash  TEXT UNIQUE,
  engine_trace       JSONB,                      -- warnings, plan check, flags at build time
  created_by         UUID REFERENCES public.qe_staff(user_id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at            TIMESTAMPTZ,
  viewed_at          TIMESTAMPTZ,
  accepted_at        TIMESTAMPTZ,
  UNIQUE (request_id, version)
);

CREATE TABLE public.qe_quote_options (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           UUID        NOT NULL REFERENCES public.qe_quotes(id) ON DELETE CASCADE,
  tier               TEXT        NOT NULL CHECK (tier IN ('essential', 'standard', 'premium', 'estimate', 'draft')),
  subtotal           INTEGER     NOT NULL,
  discount           INTEGER     NOT NULL DEFAULT 0,
  net                INTEGER     NOT NULL,
  vat                INTEGER     NOT NULL DEFAULT 0,
  total              INTEGER     NOT NULL,
  total_high         INTEGER,
  deposit            INTEGER     NOT NULL,
  selected           BOOLEAN     NOT NULL DEFAULT false,
  UNIQUE (quote_id, tier)
);

CREATE TABLE public.qe_quote_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  option_id          UUID        NOT NULL REFERENCES public.qe_quote_options(id) ON DELETE CASCADE,
  position           SMALLINT    NOT NULL,
  rate_item_key      TEXT,                       -- NULL for lines staff typed by hand
  kind               TEXT        NOT NULL,
  label              TEXT        NOT NULL,
  quantity           INTEGER     NOT NULL,
  unit_price         INTEGER     NOT NULL,
  amount             INTEGER     NOT NULL,
  tbc                BOOLEAN     NOT NULL DEFAULT false,
  note               TEXT
);

CREATE TABLE public.qe_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           UUID        NOT NULL REFERENCES public.qe_quotes(id),
  option_id          UUID        NOT NULL REFERENCES public.qe_quote_options(id),
  lead_id            UUID        NOT NULL REFERENCES public.qe_leads(id),
  price              INTEGER     NOT NULL,
  currency           TEXT        NOT NULL DEFAULT 'KES',
  deposit_amount     INTEGER     NOT NULL,
  deposit_status     TEXT        NOT NULL DEFAULT 'pending' CHECK (deposit_status IN ('pending', 'paid', 'refunded')),
  balance_amount     INTEGER     NOT NULL,
  balance_status     TEXT        NOT NULL DEFAULT 'pending' CHECK (balance_status IN ('pending', 'paid', 'waived')),
  shoot_date         DATE,
  location_text      TEXT,
  location_lat       NUMERIC(9, 6),
  location_lng       NUMERIC(9, 6),
  assigned_staff_id  UUID REFERENCES public.qe_staff(user_id),
  hours_travel       NUMERIC(5, 2) NOT NULL DEFAULT 0,
  hours_shoot        NUMERIC(5, 2) NOT NULL DEFAULT 0,
  hours_edit         NUMERIC(5, 2) NOT NULL DEFAULT 0,
  hours_admin        NUMERIC(5, 2) NOT NULL DEFAULT 0,
  delivered_at       TIMESTAMPTZ,
  tour_url           TEXT,
  space_id           UUID,                       -- the delivered Viewora space (no FK: properties is not touched)
  -- Copied in so a closed job exports straight to the profitability tracker
  industry           TEXT,
  client_type        TEXT,
  source             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_job_costs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID        NOT NULL REFERENCES public.qe_jobs(id) ON DELETE CASCADE,
  label              TEXT        NOT NULL,
  amount             INTEGER     NOT NULL CHECK (amount >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID REFERENCES public.qe_jobs(id),
  quote_id           UUID        NOT NULL REFERENCES public.qe_quotes(id),
  kind               TEXT        NOT NULL CHECK (kind IN ('deposit', 'balance')),
  provider           TEXT        NOT NULL DEFAULT 'paystack',
  reference          TEXT        NOT NULL UNIQUE,  -- a repeated webhook can't record a payment twice
  amount             INTEGER     NOT NULL,
  currency           TEXT        NOT NULL DEFAULT 'KES',
  status             TEXT        NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized', 'success', 'failed')),
  raw_event          JSONB,
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_message_templates (
  key                TEXT        NOT NULL,
  channel            TEXT        NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  locale             TEXT        NOT NULL DEFAULT 'en',
  version            INTEGER     NOT NULL DEFAULT 1,
  subject            TEXT,
  body               TEXT        NOT NULL,       -- placeholders like {{name}}, {{quote_link}}, {{amount}}
  wa_template_name   TEXT,                       -- Meta-approved template, once on the Business Platform
  active             BOOLEAN     NOT NULL DEFAULT true,
  updated_by         UUID REFERENCES public.qe_staff(user_id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, channel, locale, version)
);

CREATE TABLE public.qe_sequences (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID        NOT NULL REFERENCES public.qe_leads(id) ON DELETE CASCADE,
  sequence_key       TEXT        NOT NULL,       -- abandoned, quote_followup, post_delivery...
  status             TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  stop_reason        TEXT,                       -- replied, booked, lost, opted_out
  next_step          SMALLINT    NOT NULL DEFAULT 0,
  next_run_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID        NOT NULL REFERENCES public.qe_leads(id) ON DELETE CASCADE,
  sequence_id        UUID REFERENCES public.qe_sequences(id) ON DELETE SET NULL,
  channel            TEXT        NOT NULL CHECK (channel IN ('whatsapp', 'email', 'staff_alert')),
  template_key       TEXT        NOT NULL,
  template_version   INTEGER,
  rendered_body      TEXT,
  status             TEXT        NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  skip_reason        TEXT,                       -- quiet_hours, opted_out, weekly_cap, stopped
  provider_message_id TEXT,
  scheduled_for      TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  read_at            TIMESTAMPTZ,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qe_messages_lead_idx ON public.qe_messages(lead_id, created_at DESC);

CREATE TABLE public.qe_notes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID        NOT NULL REFERENCES public.qe_leads(id) ON DELETE CASCADE,
  author_id          UUID REFERENCES public.qe_staff(user_id),
  body               TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.qe_audit_log (
  id                 BIGSERIAL PRIMARY KEY,
  actor_id           UUID REFERENCES public.qe_staff(user_id),
  entity_type        TEXT        NOT NULL,       -- quote, rate_table, rate_item, staff, template
  entity_id          TEXT        NOT NULL,
  action             TEXT        NOT NULL,
  before             JSONB,
  after              JSONB,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qe_audit_entity_idx ON public.qe_audit_log(entity_type, entity_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'qe_staff', 'qe_partners', 'qe_consent_texts', 'qe_leads', 'qe_rate_tables', 'qe_rate_items',
    'qe_entry_links', 'qe_quote_requests', 'qe_quotes', 'qe_quote_options', 'qe_quote_lines',
    'qe_jobs', 'qe_job_costs', 'qe_payments', 'qe_message_templates', 'qe_sequences',
    'qe_messages', 'qe_notes', 'qe_audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

COMMIT;
