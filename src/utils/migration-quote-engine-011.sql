-- Quote engine 011: staff email from profiles, not auth.users
--
-- qe_desk_staff, qe_desk_staff_list and qe_alert_recipients joined
-- auth.users for the staff member's email. The service role cannot read
-- auth.users on this project ("permission denied for table users"), so
-- every staff check failed. profiles.email holds the same address.
--
-- CREATE OR REPLACE keeps each function's existing grants (service role only).
-- Rollback: migration-quote-engine-011.down.sql

CREATE OR REPLACE FUNCTION public.qe_desk_staff(p_user UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object('userId', s.user_id, 'displayName', s.display_name, 'role', s.role,
    'discountLimitBp', s.discount_limit_bp, 'email', p.email)
  FROM qe_staff s LEFT JOIN profiles p ON p.id = s.user_id
  WHERE s.user_id = p_user AND s.active
$$;

CREATE OR REPLACE FUNCTION public.qe_desk_staff_list() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('userId', s.user_id, 'displayName', s.display_name, 'role', s.role,
    'discountLimitBp', s.discount_limit_bp, 'email', p.email) ORDER BY s.display_name), '[]'::jsonb)
  FROM qe_staff s LEFT JOIN profiles p ON p.id = s.user_id
  WHERE s.active
$$;

CREATE OR REPLACE FUNCTION public.qe_alert_recipients() RETURNS SETOF TEXT
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT p.email::text FROM qe_staff s JOIN profiles p ON p.id = s.user_id
  WHERE s.active AND s.alert_new_leads AND p.email IS NOT NULL
$$;
