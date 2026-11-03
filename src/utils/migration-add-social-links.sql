-- Migration: social links on a space
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- { "instagram": "https://instagram.com/...", "tiktok": "...", ... } — validated
-- and normalised by the backend (utils/socialLinks.ts) on save. An empty
-- object (the default) means no social icons in the viewer.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS social_links jsonb NOT NULL DEFAULT '{}'::jsonb;
