-- Rollback for migration-partner-api-003.sql: removes the listing model tables.
-- Deletes all listing state, audit rows and idempotency keys. Tours, agents,
-- partners and keys (migrations 001 and 002) are not touched.

BEGIN;

DROP TABLE IF EXISTS public.api_idempotency_keys;
-- The row trigger would refuse the DELETEs a DROP does not need; DROP is fine.
DROP TABLE IF EXISTS public.api_audit_log;
DROP TABLE IF EXISTS public.api_listing_state;

DROP FUNCTION IF EXISTS public.api_audit_log_no_truncate();
DROP FUNCTION IF EXISTS public.api_audit_log_guard();
DROP FUNCTION IF EXISTS public.api_listing_state_stamp();

COMMIT;

NOTIFY pgrst, 'reload schema';
