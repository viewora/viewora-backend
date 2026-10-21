-- Migration: AI assistant usage limits + AI photo edits with undo
-- Run in Supabase Dashboard > SQL Editor > New query

-- ── 1. Per-plan monthly AI allowances ─────────────────────────────────────────
-- NULL = unlimited (custom/Enterprise), 0 = feature off.
--   ai_prompts_per_month     — assistant prompts, auto-link runs, description drafts
--                              (free-tier Gemini text model, but the free quota is shared
--                              by ALL Viewora users on one API key, so it still needs a cap)
--   ai_image_edits_per_month — object removal / insertion in photos (paid Gemini image model,
--                              ~US$0.03–0.07 per edit)
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS ai_prompts_per_month     INTEGER DEFAULT 20,
  ADD COLUMN IF NOT EXISTS ai_image_edits_per_month INTEGER DEFAULT 0;

-- Starting values — adjust per plan in the Table Editor.
UPDATE plans SET ai_prompts_per_month = 20,  ai_image_edits_per_month = 0  WHERE slug = 'free';
UPDATE plans SET ai_prompts_per_month = 200, ai_image_edits_per_month = 20 WHERE slug <> 'free';

-- ── 2. Usage counters (one row per user per calendar month, UTC) ──────────────
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id     UUID    NOT NULL,
  period      TEXT    NOT NULL,              -- 'YYYY-MM'
  prompts     INTEGER NOT NULL DEFAULT 0,
  image_edits INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
);

-- Only the backend (service role) touches this table.
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

-- Atomic "use one if under the limit". Returns the new count, or -1 when the
-- limit is already reached. p_limit NULL = unlimited.
CREATE OR REPLACE FUNCTION consume_ai_usage(p_user UUID, p_period TEXT, p_kind TEXT, p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_kind NOT IN ('prompts', 'image_edits') THEN
    RAISE EXCEPTION 'unknown ai usage kind %', p_kind;
  END IF;

  INSERT INTO ai_usage (user_id, period) VALUES (p_user, p_period)
  ON CONFLICT (user_id, period) DO NOTHING;

  IF p_kind = 'prompts' THEN
    UPDATE ai_usage SET prompts = prompts + 1, updated_at = now()
    WHERE user_id = p_user AND period = p_period AND (p_limit IS NULL OR prompts < p_limit)
    RETURNING prompts INTO v_count;
  ELSE
    UPDATE ai_usage SET image_edits = image_edits + 1, updated_at = now()
    WHERE user_id = p_user AND period = p_period AND (p_limit IS NULL OR image_edits < p_limit)
    RETURNING image_edits INTO v_count;
  END IF;

  RETURN COALESCE(v_count, -1);
END;
$$;

-- Gives one back when the AI call failed after it was counted.
CREATE OR REPLACE FUNCTION refund_ai_usage(p_user UUID, p_period TEXT, p_kind TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_kind = 'prompts' THEN
    UPDATE ai_usage SET prompts = GREATEST(prompts - 1, 0) WHERE user_id = p_user AND period = p_period;
  ELSIF p_kind = 'image_edits' THEN
    UPDATE ai_usage SET image_edits = GREATEST(image_edits - 1, 0) WHERE user_id = p_user AND period = p_period;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION consume_ai_usage(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION refund_ai_usage(UUID, TEXT, TEXT)           FROM PUBLIC, anon, authenticated;

-- ── 3. Undo for AI photo edits ────────────────────────────────────────────────
-- Set the first time a scene's photo is edited; raw_image_url then points at the
-- edited panorama. Reverting copies it back and clears this column.
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS original_raw_image_url TEXT;

-- NOTE: billing:status is cached in Redis — plan changes made here show up for a
-- user after their cache refreshes (webhook or next GET /billing/status miss).
