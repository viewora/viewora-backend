-- Migration: add room_layout_json to scenes for AI-generated room polygons (Tier 2)
-- This column is filled by HorizonNet inference via POST /internal/scenes/:id/room-layout.
-- When null the floor-plan generator falls back to Tier 1 hotspot-graph estimation.
-- Run in Supabase Dashboard > SQL Editor > New query

ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS room_layout_json JSONB;
