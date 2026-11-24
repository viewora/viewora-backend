-- Partner API, migration 005: what the listing API still missed.
-- Rollback: migration-partner-api-005.down.sql
--
-- Adds:
--   * api_texts            editable wording (lead-sharing consent, partner
--                          emails), versioned; nothing is hardcoded in code,
--   * api_lead_consents    the exact consent wording a buyer saw and their
--                          answer, per lead, with a timestamp; a lead reaches
--                          a partner only when this says yes,
--   * api_listing_claims   a partner asks to link a tour an agent made in the
--                          Viewora app; the agent approves or declines,
--   * webhook secret rotation: the previous secret keeps signing for 24 h,
--   * api_export_spaces()  the export feed as one query (no agent-count cap).
--
-- No existing non-partner table is changed: api_lead_consents references
-- public.leads and api_listing_claims references public.properties without
-- altering them. RLS on, no policies. Run in the Supabase SQL editor.

BEGIN;

-- ── Editable wording ──────────────────────────────────────────────────────
CREATE TABLE public.api_texts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL CHECK (key ~ '^[a-z0-9_]{3,60}$'),
  locale      TEXT        NOT NULL DEFAULT 'en' CHECK (locale ~ '^[a-z]{2}$'),
  version     INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  subject     TEXT        CHECK (char_length(subject) <= 200),
  body        TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_by  TEXT        CHECK (char_length(created_by) <= 120),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, locale, version)
);
-- One live version per key and language; older versions stay for the record.
CREATE UNIQUE INDEX api_texts_active_idx ON public.api_texts (key, locale) WHERE active;

-- Starting wording. Staff edit it in admin (a new version each time).
-- The consent text needs a lawyer's review under Kenya's Data Protection Act.
INSERT INTO public.api_texts (key, locale, body, created_by) VALUES
  ('lead_share_consent', 'en',
   'Share my name and contact details with {partner} so they can follow up about this listing.',
   'migration-005'),
  ('webhook_disabled_email', 'en',
   E'Hello {partner},\n\nViewora stopped sending events to {url} because it has not answered with a success for 3 days. Events since then are kept.\n\nFix the endpoint, then switch it back on with POST /v1/webhooks/{webhook_id}/enable. Missed events are listed at GET /v1/webhooks/{webhook_id}/deliveries.\n\nViewora',
   'migration-005');
UPDATE public.api_texts SET subject = 'Your Viewora webhook was switched off' WHERE key = 'webhook_disabled_email';

-- ── Lead consent ──────────────────────────────────────────────────────────
CREATE TABLE public.api_lead_consents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          UUID        NOT NULL UNIQUE REFERENCES public.leads(id) ON DELETE CASCADE,
  partner_id       UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode             TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  text_id          UUID        REFERENCES public.api_texts(id),
  -- The exact words shown, with the partner's name filled in.
  wording          TEXT        NOT NULL CHECK (char_length(wording) <= 4000),
  locale           TEXT        NOT NULL DEFAULT 'en',
  accepted         BOOLEAN     NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at     TIMESTAMPTZ
);
CREATE INDEX api_lead_consents_partner_idx ON public.api_lead_consents (partner_id, mode, created_at DESC) WHERE accepted AND withdrawn_at IS NULL;

-- ── Claims: link an app-made tour to a partner listing ────────────────────
CREATE TABLE public.api_listing_claims (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  agent_id      UUID        NOT NULL REFERENCES public.api_partner_agents(id) ON DELETE CASCADE,
  space_id      UUID        NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  external_id   TEXT        NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 100),
  note          TEXT        CHECK (char_length(note) <= 300),
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days',
  decided_at    TIMESTAMPTZ,
  decided_by    UUID
);
-- One open claim per tour, and per partner listing id.
CREATE UNIQUE INDEX api_listing_claims_space_open ON public.api_listing_claims (space_id) WHERE status = 'pending';
CREATE UNIQUE INDEX api_listing_claims_ext_open ON public.api_listing_claims (partner_id, mode, external_id) WHERE status = 'pending';
CREATE INDEX api_listing_claims_agent_idx ON public.api_listing_claims (agent_id, status);

-- ── Webhook secret rotation ───────────────────────────────────────────────
ALTER TABLE public.api_webhooks
  ADD COLUMN prev_secret_cipher     TEXT,
  ADD COLUMN prev_secret_expires_at TIMESTAMPTZ;

-- ── Export feed ───────────────────────────────────────────────────────────
-- Every published tour owned by the partner's agents in one mode, newest
-- change first, with keyset paging. Replaces a list of user ids (capped).
CREATE FUNCTION public.api_export_spaces(p_partner UUID, p_mode TEXT, p_after_t TIMESTAMPTZ, p_after_id UUID, p_limit INTEGER)
RETURNS SETOF public.properties
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.* FROM public.properties p
  JOIN public.api_partner_agents a ON a.user_id = p.user_id AND a.partner_id = p_partner AND a.mode = p_mode
  WHERE p.is_published
    AND (p_after_t IS NULL OR (p.updated_at, p.id) < (p_after_t, p_after_id))
  ORDER BY p.updated_at DESC, p.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 201)
$$;
REVOKE EXECUTE ON FUNCTION public.api_export_spaces(UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.api_texts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_lead_consents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_listing_claims ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
