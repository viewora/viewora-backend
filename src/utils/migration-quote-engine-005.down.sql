-- Rollback for migration-quote-engine-005.sql.
-- Payment and job rows are kept (they are money records); only what 005
-- added goes. Payments marked 'abandoned' become 'failed' so the original
-- status check can return. Audit rows written by 005 are kept.

BEGIN;

DROP FUNCTION IF EXISTS public.qe_settings_set(TEXT, JSONB, UUID);
DROP FUNCTION IF EXISTS public.qe_settings_get(TEXT);
DROP FUNCTION IF EXISTS public.qe_booking_counts(DATE, DATE);
DROP FUNCTION IF EXISTS public.qe_job_delete_cost(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.qe_job_add_cost(UUID, TEXT, INTEGER, UUID);
DROP FUNCTION IF EXISTS public.qe_job_request_date(UUID, DATE, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.qe_job_update(UUID, JSONB, UUID);
DROP FUNCTION IF EXISTS public.qe_job_list(JSONB);
DROP FUNCTION IF EXISTS public.qe_job_for_request(UUID);
DROP FUNCTION IF EXISTS public.qe_job_get(UUID);
DROP FUNCTION IF EXISTS public.qe_invoice_update(UUID, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qe_pay_manual_balance(UUID, UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qe_pay_pending(INTEGER, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.qe_pay_checked(TEXT);
DROP FUNCTION IF EXISTS public.qe_pay_fail(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qe_pay_settle(TEXT, BIGINT, TEXT, TEXT, TIMESTAMPTZ, JSONB);
DROP FUNCTION IF EXISTS public.qe_pay_get(TEXT);
DROP FUNCTION IF EXISTS public.qe_pay_set_url(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qe_pay_create(JSONB, DATE);
DROP FUNCTION IF EXISTS public.qe_job_row(UUID);
DROP FUNCTION IF EXISTS public.qe_pay_row(UUID);

DELETE FROM public.qe_message_templates WHERE key IN ('deposit_paid', 'balance_request', 'staff_deposit_paid') AND version = 1;

DROP TABLE IF EXISTS public.qe_settings;
DROP TABLE IF EXISTS public.qe_invoices;

ALTER TABLE public.qe_job_costs DROP COLUMN IF EXISTS created_by;

DROP INDEX IF EXISTS public.qe_jobs_lead_idx;
DROP INDEX IF EXISTS public.qe_jobs_shoot_idx;
DROP INDEX IF EXISTS public.qe_jobs_quote_uidx;
ALTER TABLE public.qe_jobs
  DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS closed_at, DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS balance_paid_at, DROP COLUMN IF EXISTS deposit_paid_at, DROP COLUMN IF EXISTS shoot_date_status,
  DROP COLUMN IF EXISTS shoot_window, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS tier, DROP COLUMN IF EXISTS ref;

DROP INDEX IF EXISTS public.qe_payments_job_idx;
DROP INDEX IF EXISTS public.qe_payments_quote_idx;
DROP INDEX IF EXISTS public.qe_payments_pending_idx;
UPDATE public.qe_payments SET status = 'failed' WHERE status = 'abandoned';
ALTER TABLE public.qe_payments DROP CONSTRAINT IF EXISTS qe_payments_status_check;
ALTER TABLE public.qe_payments ADD CONSTRAINT qe_payments_status_check CHECK (status IN ('initialized', 'success', 'failed'));
ALTER TABLE public.qe_payments
  DROP COLUMN IF EXISTS note, DROP COLUMN IF EXISTS recorded_by, DROP COLUMN IF EXISTS last_checked_at, DROP COLUMN IF EXISTS checks,
  DROP COLUMN IF EXISTS live, DROP COLUMN IF EXISTS failure_reason, DROP COLUMN IF EXISTS paid_at, DROP COLUMN IF EXISTS channel,
  DROP COLUMN IF EXISTS authorization_url, DROP COLUMN IF EXISTS link_id, DROP COLUMN IF EXISTS tier;

COMMIT;
