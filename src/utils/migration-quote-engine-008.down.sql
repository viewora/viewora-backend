-- Rollback for migration-quote-engine-008.sql. Nothing but the report
-- function and its index were added, so no data is lost.

BEGIN;

DROP FUNCTION IF EXISTS public.qe_report_rows(TIMESTAMPTZ, TIMESTAMPTZ);
DROP INDEX IF EXISTS public.qe_quote_requests_started_idx;

COMMIT;
