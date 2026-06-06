-- Migration: add floor plan image URL to properties (spaces)
-- Run in Supabase Dashboard > SQL Editor > New query

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS floorplan_url TEXT;
