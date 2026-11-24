-- Rollback for migration-partner-api-004.sql.
-- Drops the listing API tables and function, and the columns 004 added.
-- Keys lose their scopes and expiry (they keep working with today's access).

BEGIN;

DROP FUNCTION IF EXISTS public.api_listing_commit(UUID, INTEGER, JSONB, JSONB, JSONB);

DROP TABLE IF EXISTS public.api_imports;
DROP TABLE IF EXISTS public.api_webhook_deliveries;
DROP TABLE IF EXISTS public.api_webhooks;
DROP TABLE IF EXISTS public.api_outbox;
DROP TABLE IF EXISTS public.api_listing_media;

ALTER TABLE public.api_listing_state
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS pending_listing,
  DROP COLUMN IF EXISTS listing;

ALTER TABLE public.api_partner_keys
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS scopes;

COMMIT;

NOTIFY pgrst, 'reload schema';
