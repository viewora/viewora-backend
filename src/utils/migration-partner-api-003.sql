-- Partner API, migration 003: the listing model (Phase 0 of the partner
-- integration platform).
-- Rollback: migration-partner-api-003.down.sql
--
-- A partner listing is still ONE tour (a properties row, linked through
-- api_partner_tours under the partner's own external_id). This migration adds
-- the partner-owned facts the tour row cannot hold (reserved/withdrawn,
-- currency, deposit, coordinates, publication state, versions), an
-- append-only audit log, and stored idempotency keys for safe retries.
--
-- Only NEW tables (prefix api_); no existing table is changed. RLS is enabled
-- with NO policies, so only the backend's service role can read or write.
-- No route uses these tables yet: Phase 1 adds /v1/listings.
-- Run in the Supabase SQL editor.

BEGIN;

-- ── Listing state: one row per partner tour ────────────────────────────────
CREATE TABLE public.api_listing_state (
  tour_ref_id            UUID PRIMARY KEY REFERENCES public.api_partner_tours(id) ON DELETE CASCADE,
  -- Copied from the tour ref by the trigger below, so they can never disagree.
  partner_id             UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode                   TEXT        NOT NULL CHECK (mode IN ('test', 'live')),

  vertical               TEXT        NOT NULL CHECK (vertical IN ('property', 'vehicle')),
  transaction            TEXT        NOT NULL CHECK (transaction IN ('sale', 'rent', 'lease')),
  -- Goes up by one on every accepted change; PATCH sends it back as If-Match.
  version                INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),

  -- Owned by the partner.
  availability           TEXT        NOT NULL DEFAULT 'available'
                         CHECK (availability IN ('available', 'reserved', 'sold', 'rented', 'withdrawn')),
  available_from         DATE,
  -- Owned by Viewora.
  publication_status     TEXT        NOT NULL DEFAULT 'draft'
                         CHECK (publication_status IN ('draft', 'submitted', 'validated', 'pending_moderation',
                                                       'published', 'rejected', 'expired', 'archived')),
  moderation_reasons     JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(moderation_reasons) = 'array'),

  -- Money is always an integer: whole KES, or USD cents. Never a float.
  price_amount           BIGINT      CHECK (price_amount IS NULL OR price_amount >= 0),
  price_currency         TEXT        CHECK (price_currency IN ('KES', 'USD')),
  price_period           TEXT        CHECK (price_period IN ('once', 'day', 'week', 'month', 'year')),
  price_negotiable       BOOLEAN     NOT NULL DEFAULT false,
  price_on_request       BOOLEAN     NOT NULL DEFAULT false,
  price_vat_inclusive    BOOLEAN,
  deposit_amount         BIGINT      CHECK (deposit_amount IS NULL OR deposit_amount >= 0),
  service_charge_amount  BIGINT      CHECK (service_charge_amount IS NULL OR service_charge_amount >= 0),
  service_charge_period  TEXT        CHECK (service_charge_period IN ('once', 'day', 'week', 'month', 'year')),
  CONSTRAINT api_listing_state_price_currency CHECK ((price_amount IS NULL) = (price_currency IS NULL)),
  -- Deposit and service charge are in the listing's currency, so need one.
  CONSTRAINT api_listing_state_extras_currency CHECK (
    (deposit_amount IS NULL AND service_charge_amount IS NULL) OR price_currency IS NOT NULL),

  location_county        TEXT        CHECK (char_length(location_county) <= 60),
  location_area          TEXT        CHECK (char_length(location_area) <= 120),
  location_estate        TEXT        CHECK (char_length(location_estate) <= 120),
  location_address_line  TEXT        CHECK (char_length(location_address_line) <= 200),
  location_lat           NUMERIC(9,6) CHECK (location_lat BETWEEN -90 AND 90),
  location_lng           NUMERIC(9,6) CHECK (location_lng BETWEEN -180 AND 180),
  CONSTRAINT api_listing_state_latlng CHECK ((location_lat IS NULL) = (location_lng IS NULL)),
  -- Public pages show an approximate pin unless the partner asks for exact.
  location_display_precision TEXT    NOT NULL DEFAULT 'approx_500m'
                         CHECK (location_display_precision IN ('exact', 'approx_500m', 'area_only')),

  branch_external_id     TEXT        CHECK (char_length(branch_external_id) BETWEEN 1 AND 120),
  branch_name            TEXT        CHECK (char_length(branch_name) <= 120),
  branch_town            TEXT        CHECK (char_length(branch_town) <= 80),

  -- The vertical block (property or vehicle fields), validated by
  -- src/partners/listingModel.ts before it is written.
  details                JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  -- Vehicles only: SHA-256 of the normalised VIN / chassis number, for
  -- duplicate checks across partners without storing the number twice.
  vin_hash               TEXT        CHECK (vin_hash ~ '^[0-9a-f]{64}$'),
  chassis_hash           TEXT        CHECK (chassis_hash ~ '^[0-9a-f]{64}$'),

  -- The partner's own clock: an update older than this one is ignored.
  partner_updated_at     TIMESTAMPTZ,
  change_origin          TEXT        NOT NULL DEFAULT 'api' CHECK (change_origin IN ('api', 'app', 'admin', 'system')),
  last_import_id         UUID,

  published_at           TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ,
  archived_at            TIMESTAMPTZ,
  restore_until          TIMESTAMPTZ,
  CONSTRAINT api_listing_state_archive CHECK (
    (publication_status = 'archived') = (archived_at IS NOT NULL)),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX api_listing_state_partner_updated_idx ON public.api_listing_state (partner_id, mode, updated_at DESC);
CREATE INDEX api_listing_state_partner_avail_idx   ON public.api_listing_state (partner_id, mode, availability);
CREATE INDEX api_listing_state_moderation_idx      ON public.api_listing_state (publication_status)
  WHERE publication_status IN ('submitted', 'pending_moderation');
CREATE INDEX api_listing_state_expires_idx         ON public.api_listing_state (expires_at)
  WHERE expires_at IS NOT NULL AND publication_status = 'published';
CREATE INDEX api_listing_state_vin_idx             ON public.api_listing_state (vin_hash) WHERE vin_hash IS NOT NULL;
CREATE INDEX api_listing_state_chassis_idx         ON public.api_listing_state (chassis_hash) WHERE chassis_hash IS NOT NULL;
CREATE INDEX api_listing_state_area_idx            ON public.api_listing_state (location_county, location_area);

-- partner_id and mode always come from the tour ref; updated_at is stamped.
CREATE FUNCTION public.api_listing_state_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  SELECT t.partner_id, t.mode INTO NEW.partner_id, NEW.mode
  FROM public.api_partner_tours t WHERE t.id = NEW.tour_ref_id;
  IF NEW.partner_id IS NULL THEN
    RAISE EXCEPTION 'api_listing_state: no api_partner_tours row %', NEW.tour_ref_id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER api_listing_state_stamp
  BEFORE INSERT OR UPDATE ON public.api_listing_state
  FOR EACH ROW EXECUTE FUNCTION public.api_listing_state_stamp();

-- ── Audit log: append-only ────────────────────────────────────────────────
-- No foreign keys on purpose: the trail must outlive the partner, key or
-- listing it describes. Rows older than 24 months may be deleted (retention);
-- nothing can be updated.
CREATE TABLE public.api_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  partner_id    UUID,
  mode          TEXT        CHECK (mode IN ('test', 'live')),
  actor_type    TEXT        NOT NULL CHECK (actor_type IN ('partner_key', 'user', 'staff', 'system')),
  actor_id      TEXT        CHECK (char_length(actor_id) <= 120),
  action        TEXT        NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),   -- e.g. listing.updated
  entity_type   TEXT        NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 40),
  entity_id     TEXT        CHECK (char_length(entity_id) <= 120),
  -- { field: [before, after] } for changed fields only. Never raw secrets or lead contacts.
  changes       JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes) = 'object'),
  request_id    TEXT        CHECK (char_length(request_id) <= 80),
  ip            INET
);
CREATE INDEX api_audit_log_partner_idx ON public.api_audit_log (partner_id, occurred_at DESC);
CREATE INDEX api_audit_log_entity_idx  ON public.api_audit_log (entity_type, entity_id, occurred_at DESC);

CREATE FUNCTION public.api_audit_log_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.occurred_at < now() - interval '24 months' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'api_audit_log is append-only (% refused)', TG_OP;
END $$;

CREATE TRIGGER api_audit_log_no_change
  BEFORE UPDATE OR DELETE ON public.api_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.api_audit_log_guard();

CREATE FUNCTION public.api_audit_log_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'api_audit_log is append-only (TRUNCATE refused)';
END $$;

CREATE TRIGGER api_audit_log_no_truncate
  BEFORE TRUNCATE ON public.api_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.api_audit_log_no_truncate();

-- ── Idempotency keys: a retried POST returns the first answer ──────────────
CREATE TABLE public.api_idempotency_keys (
  partner_id    UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  idem_key      TEXT        NOT NULL CHECK (char_length(idem_key) BETWEEN 1 AND 255),
  method        TEXT        NOT NULL CHECK (method IN ('POST', 'PATCH', 'DELETE')),
  path          TEXT        NOT NULL CHECK (char_length(path) <= 300),
  -- SHA-256 of the request body: the same key with a different body is refused.
  request_hash  TEXT        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- NULL while the first request is still running.
  status_code   INTEGER     CHECK (status_code BETWEEN 100 AND 599),
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (partner_id, mode, idem_key)
);
CREATE INDEX api_idempotency_keys_expires_idx ON public.api_idempotency_keys (expires_at);

ALTER TABLE public.api_listing_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_audit_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_idempotency_keys ENABLE ROW LEVEL SECURITY;

-- The trigger functions are not callable through the REST API.
REVOKE ALL ON FUNCTION public.api_listing_state_stamp()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_audit_log_guard()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_audit_log_no_truncate() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
