-- Rollback for migration-quote-engine-009.sql. Drops which account a request
-- was started from. qe_leads.user_id belongs to migration 001 and stays;
-- values 009 wrote there are left as they are.

BEGIN;

DROP FUNCTION IF EXISTS public.qe_lead_link_account(UUID, UUID);
DROP INDEX IF EXISTS public.qe_leads_user_idx;
DROP INDEX IF EXISTS public.qe_quote_requests_user_idx;
ALTER TABLE public.qe_quote_requests DROP COLUMN IF EXISTS user_id;

COMMIT;
