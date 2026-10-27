-- Rollback for migration-quote-engine-003.sql.
-- Requests answered "marketing agency" or "something else" lose that answer
-- (set to NULL) so the original four-value check can come back.

BEGIN;

DROP FUNCTION IF EXISTS public.qe_admin_leads(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.qe_admin_lead(UUID);
DROP FUNCTION IF EXISTS public.qe_admin_summary();
DROP FUNCTION IF EXISTS public.qe_alert_recipients();

DELETE FROM public.qe_message_templates WHERE key = 'staff_new_lead' AND channel = 'email' AND locale = 'en' AND version = 1;

UPDATE public.qe_quote_requests SET client_type = NULL WHERE client_type IN ('marketer', 'other');
ALTER TABLE public.qe_quote_requests DROP CONSTRAINT IF EXISTS qe_quote_requests_client_type_check;
ALTER TABLE public.qe_quote_requests ADD CONSTRAINT qe_quote_requests_client_type_check
  CHECK (client_type IN ('owner', 'agent', 'developer', 'manager'));

COMMIT;
