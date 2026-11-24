-- Partner API, migration 004: the listing API (Phases 1 to 3 of the partner
-- integration platform).
-- Rollback: migration-partner-api-004.down.sql
--
-- Adds:
--   * api_partners.max_live_listings (default 2,000, per agreement),
--   * key scopes and expiry on api_partner_keys (two NULLable columns; NULL
--     scopes = the key keeps the access it has today, so existing keys work),
--   * the stored listing and a held change on api_listing_state,
--   * api_listing_media    media a partner sent by URL, fetched by a worker,
--   * api_outbox           every listing event, written in the same
--                          transaction as the change (no event is lost),
--   * api_webhooks         partner endpoints; the signing secret is stored
--                          encrypted (AES-256-GCM, key in env), not hashed,
--                          because Viewora signs with it,
--   * api_webhook_deliveries  one row per event per endpoint, with retries;
--                          status 'dead' is the dead-letter list in admin,
--   * api_imports          bulk upserts, processed by a worker,
--   * api_listing_commit() writes a listing, its audit row and its events
--                          in ONE transaction, with the version check.
--
-- No existing non-partner table is changed. RLS on, no policies: only the
-- backend's service role can read or write. Run in the Supabase SQL editor.

BEGIN;

-- ── Keys: scopes and expiry ────────────────────────────────────────────────
-- NULL scopes = a key issued before scopes existed: everything except
-- leads:read (leads need a signed data-processing addendum first).
ALTER TABLE public.api_partner_keys
  ADD COLUMN scopes     TEXT[] CHECK (scopes <@ ARRAY['listings:read', 'listings:write', 'media:write', 'agents:write',
                                                     'webhooks:manage', 'leads:read', 'analytics:read']::TEXT[]),
  ADD COLUMN expires_at TIMESTAMPTZ;

-- ── Partners: how many live listings the agreement allows ─────────────────
ALTER TABLE public.api_partners
  ADD COLUMN max_live_listings INTEGER NOT NULL DEFAULT 2000 CHECK (max_live_listings BETWEEN 0 AND 1000000);

-- ── Listing state: the stored listing and a held change ───────────────────
ALTER TABLE public.api_listing_state
  -- The partner's listing as last accepted (raw VIN and chassis number
  -- removed; their hashes are in vin_hash / chassis_hash).
  ADD COLUMN listing          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(listing) = 'object'),
  -- A risky change waiting for a moderator. The public page keeps showing
  -- `listing` until it is approved.
  ADD COLUMN pending_listing  JSONB CHECK (pending_listing IS NULL OR jsonb_typeof(pending_listing) = 'object'),
  ADD COLUMN reviewed_at      TIMESTAMPTZ,
  ADD COLUMN reviewed_by      TEXT CHECK (char_length(reviewed_by) <= 120);

-- ── Media sent by URL ──────────────────────────────────────────────────────
CREATE TABLE public.api_listing_media (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_ref_id    UUID        NOT NULL REFERENCES public.api_partner_tours(id) ON DELETE CASCADE,
  partner_id     UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode           TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  kind           TEXT        NOT NULL CHECK (kind IN ('photo', 'panorama', 'tour', 'car_exterior', 'floor_plan', 'video', 'document')),
  source_url     TEXT        NOT NULL CHECK (char_length(source_url) <= 2048 AND source_url LIKE 'https://%'),
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  caption        TEXT        CHECK (char_length(caption) <= 140),
  angle          INTEGER     CHECK (angle BETWEEN 0 AND 359),
  status         TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'fetching', 'ready', 'failed', 'skipped', 'removed')),
  error_code     TEXT        CHECK (char_length(error_code) <= 60),
  error_message  TEXT        CHECK (char_length(error_message) <= 300),
  attempts       INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until   TIMESTAMPTZ,
  sha256         TEXT        CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes          BIGINT,
  -- The tour's own media rows once the file is in R2.
  space_media_id UUID,
  vehicle_view_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tour_ref_id, source_url)
);
CREATE INDEX api_listing_media_due_idx ON public.api_listing_media (next_attempt_at) WHERE status = 'pending';
CREATE INDEX api_listing_media_ref_idx ON public.api_listing_media (tour_ref_id);

-- ── Outbox: events written with the change ─────────────────────────────────
CREATE TABLE public.api_outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            BIGSERIAL   NOT NULL UNIQUE,
  partner_id     UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode           TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  event_type     TEXT        NOT NULL CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  -- IDs and state only. Never lead contact details.
  payload        JSONB       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at  TIMESTAMPTZ
);
CREATE INDEX api_outbox_undispatched_idx ON public.api_outbox (seq) WHERE dispatched_at IS NULL;

-- ── Webhook endpoints ──────────────────────────────────────────────────────
CREATE TABLE public.api_webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode            TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  url             TEXT        NOT NULL CHECK (char_length(url) <= 2048 AND url LIKE 'https://%'),
  events          TEXT[]      NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 30),
  -- AES-256-GCM: base64(iv) . base64(tag) . base64(ciphertext). Key: PARTNER_WEBHOOK_KEY.
  secret_cipher   TEXT        NOT NULL,
  secret_prefix   TEXT        NOT NULL CHECK (char_length(secret_prefix) <= 16),
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason TEXT        CHECK (char_length(disabled_reason) <= 200),
  -- Start of the current run of failures; NULL after a success.
  failing_since   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX api_webhooks_partner_idx ON public.api_webhooks (partner_id, mode) WHERE deleted_at IS NULL;

CREATE TABLE public.api_webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID        NOT NULL REFERENCES public.api_webhooks(id) ON DELETE CASCADE,
  event_id        UUID        NOT NULL REFERENCES public.api_outbox(id) ON DELETE CASCADE,
  partner_id      UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'dead', 'discarded')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until    TIMESTAMPTZ,
  last_status     INTEGER,
  last_error      TEXT        CHECK (char_length(last_error) <= 300),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX api_webhook_deliveries_due_idx  ON public.api_webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX api_webhook_deliveries_dead_idx ON public.api_webhook_deliveries (partner_id, created_at DESC) WHERE status = 'dead';

-- ── Bulk imports ───────────────────────────────────────────────────────────
CREATE TABLE public.api_imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  key_id        UUID,
  status        TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  dry_run       BOOLEAN     NOT NULL DEFAULT false,
  -- The items as received; cleared when the import finishes.
  items         JSONB       CHECK (items IS NULL OR jsonb_typeof(items) = 'array'),
  total         INTEGER     NOT NULL CHECK (total BETWEEN 1 AND 500),
  -- Next item to process (items are processed in order, in chunks).
  cursor        INTEGER     NOT NULL DEFAULT 0,
  counts        JSONB       NOT NULL DEFAULT '{"created":0,"updated":0,"unchanged":0,"failed":0}'::jsonb,
  -- [{ index, external_id, code, field, message }]
  errors        JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX api_imports_partner_idx ON public.api_imports (partner_id, mode, created_at DESC);
CREATE INDEX api_imports_queue_idx   ON public.api_imports (created_at) WHERE status IN ('queued', 'running');

ALTER TABLE public.api_listing_media      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_outbox             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_webhooks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_imports            ENABLE ROW LEVEL SECURITY;

-- ── One transaction per listing change ─────────────────────────────────────
-- p_expected_version NULL  → insert a new state row (unique violation 23505
--                            if the tour already has one).
-- p_expected_version N     → update only if the stored version is N, else
--                            SQLSTATE VO409. A missing row is SQLSTATE VO404.
-- p_state   columns to set (keys not sent keep their value).
-- p_audit   { actor_type, actor_id, action, changes, request_id }
-- p_events  [ { event_type, payload } ]
-- Returns { version, created_at, updated_at }.
CREATE FUNCTION public.api_listing_commit(
  p_tour_ref_id UUID, p_expected_version INTEGER, p_state JSONB, p_audit JSONB, p_events JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  cur public.api_listing_state;
  nxt public.api_listing_state;
  ev  JSONB;
BEGIN
  IF p_expected_version IS NULL THEN
    nxt := jsonb_populate_record(NULL::public.api_listing_state, p_state || jsonb_build_object('tour_ref_id', p_tour_ref_id, 'version', 1));
    -- A record built from JSON has no column defaults; apply them here.
    nxt.created_at                 := now();
    nxt.availability               := COALESCE(nxt.availability, 'available');
    nxt.publication_status         := COALESCE(nxt.publication_status, 'draft');
    nxt.moderation_reasons         := COALESCE(nxt.moderation_reasons, '[]'::jsonb);
    nxt.price_negotiable           := COALESCE(nxt.price_negotiable, false);
    nxt.price_on_request           := COALESCE(nxt.price_on_request, false);
    nxt.location_display_precision := COALESCE(nxt.location_display_precision, 'approx_500m');
    nxt.details                    := COALESCE(nxt.details, '{}'::jsonb);
    nxt.change_origin              := COALESCE(nxt.change_origin, 'api');
    nxt.listing                    := COALESCE(nxt.listing, '{}'::jsonb);
    INSERT INTO public.api_listing_state SELECT nxt.* RETURNING * INTO nxt;
  ELSE
    SELECT * INTO cur FROM public.api_listing_state WHERE tour_ref_id = p_tour_ref_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'listing state % not found', p_tour_ref_id USING ERRCODE = 'VO404';
    END IF;
    IF cur.version <> p_expected_version THEN
      RAISE EXCEPTION 'version conflict: stored %, expected %', cur.version, p_expected_version USING ERRCODE = 'VO409';
    END IF;
    nxt := jsonb_populate_record(cur, p_state - 'tour_ref_id' - 'partner_id' - 'mode' - 'version' - 'created_at');
    UPDATE public.api_listing_state SET
      vertical = nxt.vertical, transaction = nxt.transaction, version = cur.version + 1,
      availability = nxt.availability, available_from = nxt.available_from,
      publication_status = nxt.publication_status, moderation_reasons = nxt.moderation_reasons,
      price_amount = nxt.price_amount, price_currency = nxt.price_currency, price_period = nxt.price_period,
      price_negotiable = nxt.price_negotiable, price_on_request = nxt.price_on_request,
      price_vat_inclusive = nxt.price_vat_inclusive, deposit_amount = nxt.deposit_amount,
      service_charge_amount = nxt.service_charge_amount, service_charge_period = nxt.service_charge_period,
      location_county = nxt.location_county, location_area = nxt.location_area, location_estate = nxt.location_estate,
      location_address_line = nxt.location_address_line, location_lat = nxt.location_lat, location_lng = nxt.location_lng,
      location_display_precision = nxt.location_display_precision,
      branch_external_id = nxt.branch_external_id, branch_name = nxt.branch_name, branch_town = nxt.branch_town,
      details = nxt.details, vin_hash = nxt.vin_hash, chassis_hash = nxt.chassis_hash,
      partner_updated_at = nxt.partner_updated_at, change_origin = nxt.change_origin, last_import_id = nxt.last_import_id,
      published_at = nxt.published_at, expires_at = nxt.expires_at, archived_at = nxt.archived_at,
      restore_until = nxt.restore_until, listing = nxt.listing, pending_listing = nxt.pending_listing,
      reviewed_at = nxt.reviewed_at, reviewed_by = nxt.reviewed_by
    WHERE tour_ref_id = p_tour_ref_id
    RETURNING * INTO nxt;
  END IF;

  IF p_audit IS NOT NULL THEN
    INSERT INTO public.api_audit_log (partner_id, mode, actor_type, actor_id, action, entity_type, entity_id, changes, request_id)
    VALUES (nxt.partner_id, nxt.mode, p_audit->>'actor_type', p_audit->>'actor_id', p_audit->>'action',
            'listing', p_tour_ref_id::text, COALESCE(p_audit->'changes', '{}'::jsonb), p_audit->>'request_id');
  END IF;

  FOR ev IN SELECT * FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) LOOP
    INSERT INTO public.api_outbox (partner_id, mode, event_type, payload)
    VALUES (nxt.partner_id, nxt.mode, ev->>'event_type', ev->'payload');
  END LOOP;

  RETURN jsonb_build_object('version', nxt.version, 'created_at', nxt.created_at, 'updated_at', nxt.updated_at);
END $$;

-- Only the backend (service role) may call it.
REVOKE ALL ON FUNCTION public.api_listing_commit(UUID, INTEGER, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
