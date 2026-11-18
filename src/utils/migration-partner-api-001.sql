-- Partner API, migration 001: partner apps (property and car sites) that
-- create tours for their agents through /v1.
-- Rollback: migration-partner-api-001.down.sql
--
-- Only NEW tables (prefix api_); no existing table is changed. (qe_partners
-- is the quote engine's referral list and is unrelated.)
--
-- RLS is enabled on every table with NO policies: only the backend's
-- service role can read or write. Keys are stored as SHA-256 hashes only.
-- Run in the Supabase SQL editor.

BEGIN;

CREATE TABLE public.api_partners (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug                  TEXT        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  status                TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Sites allowed to embed this partner's tours, e.g. https://cars.example.co.ke
  allowed_embed_origins TEXT[]      NOT NULL DEFAULT '{}',
  -- Uploads per partner per day (all agents together).
  daily_upload_cap      INTEGER     NOT NULL DEFAULT 2000 CHECK (daily_upload_cap BETWEEN 0 AND 1000000),
  contact_email         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.api_partner_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  label         TEXT,
  -- First characters of the key, shown in the admin so staff can tell keys apart.
  key_prefix    TEXT        NOT NULL,
  key_hash      TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX api_partner_keys_partner_idx ON public.api_partner_keys (partner_id);

-- Each agent or dealer is a real Viewora account (auth.users), linked to
-- the partner under the partner's own id for that agent.
CREATE TABLE public.api_partner_agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  external_id   TEXT        NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 120),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, mode, external_id),
  UNIQUE (partner_id, user_id)
);

-- A tour (properties row) created through the partner API, under the
-- partner's own listing id.
CREATE TABLE public.api_partner_tours (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID        NOT NULL REFERENCES public.api_partners(id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL CHECK (mode IN ('test', 'live')),
  external_id   TEXT        NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 120),
  space_id      UUID        NOT NULL UNIQUE REFERENCES public.properties(id) ON DELETE CASCADE,
  agent_id      UUID        NOT NULL REFERENCES public.api_partner_agents(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, mode, external_id)
);
CREATE INDEX api_partner_tours_agent_idx ON public.api_partner_tours (agent_id);

ALTER TABLE public.api_partners       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_partner_keys   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_partner_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_partner_tours  ENABLE ROW LEVEL SECURITY;

COMMIT;
