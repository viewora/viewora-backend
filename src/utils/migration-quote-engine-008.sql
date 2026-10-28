-- Quote engine, migration 008: reports (Phase 5a).
--   * qe_report_rows(from, to): one row per form started in the period, with
--     how far it got (completed, quoted, booked, paid), the booked option's
--     price before VAT, and minutes from a finished form to the first thing
--     staff did on the lead. The backend adds the rows up (src/quote/reports.ts).
--   * An index on started_at so a period is a range scan.
-- Read-only: no table is changed. Requires migrations 001-007.
-- Rollback: migration-quote-engine-008.down.sql

BEGIN;

CREATE INDEX IF NOT EXISTS qe_quote_requests_started_idx ON public.qe_quote_requests(started_at);

CREATE OR REPLACE FUNCTION public.qe_report_rows(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH req AS (
    SELECT r.*,
      (SELECT substr(f, 10) FROM unnest(r.flags) f WHERE f LIKE 'industry:%' LIMIT 1) AS hint
    FROM qe_quote_requests r
    WHERE r.started_at >= p_from AND r.started_at < p_to
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'request_id', r.id,
    'started_at', r.started_at,
    'industry', COALESCE(r.hint, r.module_key),
    'source', COALESCE(r.answers->'entry'->>'source', l.source),
    'step_reached', r.step_reached,
    'ab_variant', r.ab_variant,
    'completed', r.completed_at IS NOT NULL,
    'quoted', EXISTS (SELECT 1 FROM qe_quotes q WHERE q.request_id = r.id AND q.sent_at IS NOT NULL),
    'booked', j.id IS NOT NULL,
    'paid', COALESCE(j.balance_status = 'paid', false),
    'job_value', o.net,
    'currency', j.currency,
    'first_staff_minutes', CASE WHEN t.at IS NOT NULL
      THEN GREATEST(0, round(extract(epoch FROM t.at - r.completed_at) / 60))::int END
  ) ORDER BY r.started_at), '[]'::jsonb)
  FROM req r
  LEFT JOIN qe_leads l ON l.id = r.lead_id
  LEFT JOIN LATERAL (
    SELECT jj.* FROM qe_jobs jj JOIN qe_quotes qq ON qq.id = jj.quote_id
    WHERE qq.request_id = r.id AND jj.status <> 'cancelled'
    ORDER BY jj.created_at LIMIT 1
  ) j ON true
  LEFT JOIN qe_quote_options o ON o.id = j.option_id
  LEFT JOIN LATERAL (
    SELECT min(x.at) AS at FROM (
      SELECT a.created_at AS at FROM qe_audit_log a
        WHERE a.actor_id IS NOT NULL AND a.entity_type = 'lead' AND a.entity_id = r.lead_id::text
      UNION ALL
      SELECT a.created_at FROM qe_audit_log a JOIN qe_quotes qq ON a.entity_id = qq.id::text
        WHERE a.actor_id IS NOT NULL AND a.entity_type = 'quote' AND qq.request_id = r.id
      UNION ALL
      SELECT n.created_at FROM qe_notes n WHERE n.author_id IS NOT NULL AND n.lead_id = r.lead_id
      UNION ALL
      SELECT m.done_at FROM qe_messages m WHERE m.done_by IS NOT NULL AND m.lead_id = r.lead_id
    ) x WHERE x.at >= r.completed_at
  ) t ON r.completed_at IS NOT NULL AND r.lead_id IS NOT NULL
  WHERE COALESCE(r.hint, r.module_key) IS NOT NULL
$$;

DO $$
DECLARE r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.qe_report_rows(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.qe_report_rows(TIMESTAMPTZ, TIMESTAMPTZ) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.qe_report_rows(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
  END IF;
END $$;

COMMIT;
