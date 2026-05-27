-- Migration: add lead capture / CTA fields to properties table
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS cta_enabled     BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cta_button_text VARCHAR(80)          DEFAULT 'Book a Viewing',
  ADD COLUMN IF NOT EXISTS cta_action      VARCHAR(20)          DEFAULT 'link',
  ADD COLUMN IF NOT EXISTS cta_destination TEXT;
