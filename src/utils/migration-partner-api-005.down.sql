-- Rollback for migration-partner-api-005.sql.
-- Drops claims, lead consents, editable texts, the export function and the
-- rotation columns. Recorded consents are lost: export them first if any
-- partner has received leads.

BEGIN;

DROP FUNCTION IF EXISTS public.api_export_spaces(UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER);

ALTER TABLE public.api_webhooks
  DROP COLUMN IF EXISTS prev_secret_expires_at,
  DROP COLUMN IF EXISTS prev_secret_cipher;

DROP TABLE IF EXISTS public.api_listing_claims;
DROP TABLE IF EXISTS public.api_lead_consents;
DROP TABLE IF EXISTS public.api_texts;

COMMIT;

NOTIFY pgrst, 'reload schema';
