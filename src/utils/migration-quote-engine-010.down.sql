-- Rollback for migration-quote-engine-010.sql. Drops delivery links and
-- their functions. Tours already accepted stay in the client's account:
-- undo those first from the job page if they should go back (the
-- properties.user_id change is not reversed here).

BEGIN;

DELETE FROM public.qe_message_templates WHERE key = 'tour_delivery' AND version = 1;
DROP FUNCTION IF EXISTS public.qe_delivery_undo(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.qe_delivery_accept(UUID, UUID);
DROP FUNCTION IF EXISTS public.qe_recount_usage(UUID);
DROP TABLE IF EXISTS public.qe_deliveries;

COMMIT;
