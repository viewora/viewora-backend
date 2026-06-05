-- Migration: create capture_requests table
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)

CREATE TABLE IF NOT EXISTS public.capture_requests (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service_id     TEXT,
  service_name   TEXT        NOT NULL,
  service_price  TEXT        NOT NULL,
  dept           TEXT,
  name           TEXT        NOT NULL,
  email          TEXT        NOT NULL,
  phone          TEXT        NOT NULL,
  address        TEXT        NOT NULL,
  space_name     TEXT,
  preferred_date TEXT,
  notes          TEXT,
  plan_name      TEXT,
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','confirmed','completed','cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capture_requests_user_id_idx ON public.capture_requests(user_id);
CREATE INDEX IF NOT EXISTS capture_requests_created_at_idx ON public.capture_requests(created_at DESC);

ALTER TABLE public.capture_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own capture requests"
  ON public.capture_requests FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own capture requests"
  ON public.capture_requests FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access"
  ON public.capture_requests FOR ALL
  USING (true);
