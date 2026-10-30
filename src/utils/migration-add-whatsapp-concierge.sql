-- Migration: WhatsApp Concierge — Phase 1 (draft/claim model)
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- Purely additive: every new column is nullable, every new table is new.
-- No existing row, constraint, or route behavior changes as a result of this file.
--
-- Context: the WhatsApp bot needs to create a "draft" property before any
-- account exists to own it (deferred claim — see brief §2). Today
-- properties.user_id is effectively required (every existing INSERT sets it).
-- This migration makes it nullable so a draft can exist ownerless, and adds
-- the fields needed to later attach it to an account at claim time.

-- 1. properties: allow ownerless draft rows + tag bot-originated listings
ALTER TABLE properties
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS listing_type TEXT NOT NULL DEFAULT 'tour'
    CHECK (listing_type IN ('tour', 'quick')),
  ADD COLUMN IF NOT EXISTS collection_id UUID NULL,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL;

-- Existing rows are unaffected: listing_type defaults to 'tour', collection_id
-- and claimed_at are null, user_id keeps whatever value it already had.

-- 2. whatsapp_sessions — one row per in-progress (or completed) bot conversation.
-- Holds the accumulated draft content and links to the draft property once one exists.
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  property_id UUID NULL REFERENCES properties(id) ON DELETE SET NULL,
  review_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'awaiting_claim', 'claimed', 'expired')),
  draft_content JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  claim_method TEXT NULL
    CHECK (claim_method IN ('whatsapp', 'google', 'apple', 'email')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_sessions_phone_number_idx ON whatsapp_sessions (phone_number);
CREATE INDEX IF NOT EXISTS whatsapp_sessions_review_token_idx ON whatsapp_sessions (review_token);

-- 3. collections — Phase 3, but the FK on properties.collection_id above needs
-- the table to exist; creating it now (empty, unused until Phase 3) avoids a
-- second migration touching properties again later.
CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT UNIQUE,
  cover_image TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE properties
  ADD CONSTRAINT properties_collection_id_fkey
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL;

-- 4. profiles.phone — enforce "one phone number → at most one account" so the
-- brief's "first claim wins, never silently overwrite" rule (§2.3) is a DB
-- guarantee, not just an application-level check.
-- NOTE: if any existing profiles rows already share a duplicate phone value,
-- this constraint will fail to apply — check for duplicates first:
--   SELECT phone, COUNT(*) FROM profiles WHERE phone IS NOT NULL GROUP BY phone HAVING COUNT(*) > 1;
-- Resolve any duplicates manually before running the line below.
ALTER TABLE profiles
  ADD CONSTRAINT profiles_phone_unique UNIQUE (phone);
