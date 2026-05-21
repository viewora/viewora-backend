-- Migration: add branding and location coordinate fields to properties table
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS logo_url    TEXT,
  ADD COLUMN IF NOT EXISTS phone       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS email       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS location_lat NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS location_lng NUMERIC(10, 7);
