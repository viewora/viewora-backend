-- Rollback of 011: back to reading auth.users (fails without access to it)

CREATE OR REPLACE FUNCTION public.qe_desk_staff(p_user UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object('userId', s.user_id, 'displayName', s.display_name, 'role', s.role,
    'discountLimitBp', s.discount_limit_bp, 'email', u.email)
  FROM qe_staff s LEFT JOIN auth.users u ON u.id = s.user_id
  WHERE s.user_id = p_user AND s.active
$$;

CREATE OR REPLACE FUNCTION public.qe_desk_staff_list() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('userId', s.user_id, 'displayName', s.display_name, 'role', s.role,
    'discountLimitBp', s.discount_limit_bp, 'email', u.email) ORDER BY s.display_name), '[]'::jsonb)
  FROM qe_staff s LEFT JOIN auth.users u ON u.id = s.user_id
  WHERE s.active
$$;

CREATE OR REPLACE FUNCTION public.qe_alert_recipients() RETURNS SETOF TEXT
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT u.email::text FROM qe_staff s JOIN auth.users u ON u.id = s.user_id
  WHERE s.active AND s.alert_new_leads AND u.email IS NOT NULL
$$;
