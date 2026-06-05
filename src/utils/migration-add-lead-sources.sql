-- Migration: expand leads.source to accept whatsapp and hotspot values
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- The leads.source column was originally constrained to ('direct','qr','embed').
-- This migration adds 'hotspot' and 'whatsapp' so the viewer WhatsApp button
-- and hotspot leads can be stored without a DB constraint violation.

-- Option A — if source is a PostgreSQL ENUM type named e.g. "lead_source":
-- ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'hotspot';
-- ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'whatsapp';

-- Option B — if source is a VARCHAR/TEXT column with a CHECK constraint (more common):
ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_source_check;

ALTER TABLE leads
  ADD CONSTRAINT leads_source_check
    CHECK (source IN ('direct', 'qr', 'embed', 'hotspot', 'whatsapp'));

-- Option C — if source is a plain VARCHAR with no constraint, this is a no-op:
-- (nothing needed — the column already accepts any string)
