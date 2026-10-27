-- Rollback for migration-quote-engine-004.sql.
-- Quote links are deleted (sent links stop working). Quotes waiting for
-- approval go back to draft and replaced quotes back to sent, so the
-- original status check can return. Audit rows written by 004 are kept.

BEGIN;

DROP FUNCTION IF EXISTS public.qe_admin_lead_v2(UUID);
DROP FUNCTION IF EXISTS public.qe_admin_leads_v2(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.qe_rt_open_quotes(UUID);
DROP FUNCTION IF EXISTS public.qe_rt_delete_draft(UUID, UUID);
DROP FUNCTION IF EXISTS public.qe_rt_publish(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.qe_rt_update_settings(UUID, JSONB, UUID);
DROP FUNCTION IF EXISTS public.qe_rt_update_item(UUID, TEXT, JSONB, UUID);
DROP FUNCTION IF EXISTS public.qe_rt_create_draft(UUID, UUID);
DROP FUNCTION IF EXISTS public.qe_rt_get(UUID);
DROP FUNCTION IF EXISTS public.qe_rt_list();
DROP FUNCTION IF EXISTS public.qe_rt_meta(UUID);
DROP FUNCTION IF EXISTS public.qe_desk_add_note(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.qe_desk_update_lead(UUID, JSONB, UUID);
DROP FUNCTION IF EXISTS public.qe_desk_quote_lost(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.qe_desk_link_seen(UUID);
DROP FUNCTION IF EXISTS public.qe_desk_find_link(TEXT);
DROP FUNCTION IF EXISTS public.qe_desk_mark_sent(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.qe_desk_decide_approval(UUID, UUID, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.qe_desk_save_quote(JSONB, JSONB, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qe_desk_request(UUID);
DROP FUNCTION IF EXISTS public.qe_desk_latest_request(UUID);
DROP FUNCTION IF EXISTS public.qe_desk_staff_list();
DROP FUNCTION IF EXISTS public.qe_desk_staff(UUID);
DROP FUNCTION IF EXISTS public.qe_desk_lead(UUID);
DROP FUNCTION IF EXISTS public.qe_desk_quote(UUID);
DROP FUNCTION IF EXISTS public.qe_desk_audit(UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT);

DELETE FROM public.qe_message_templates WHERE key = 'quote_link' AND locale = 'en' AND version = 1;

DROP INDEX IF EXISTS public.qe_quotes_request_idx;
DROP INDEX IF EXISTS public.qe_leads_owner_idx;
DROP TABLE IF EXISTS public.qe_quote_links;

ALTER TABLE public.qe_messages DROP COLUMN IF EXISTS quote_id;

UPDATE public.qe_quotes SET status = 'draft' WHERE status = 'needs_approval';
UPDATE public.qe_quotes SET status = 'sent' WHERE status = 'superseded';
ALTER TABLE public.qe_quotes DROP CONSTRAINT IF EXISTS qe_quotes_status_check;
ALTER TABLE public.qe_quotes ADD CONSTRAINT qe_quotes_status_check
  CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'expired', 'lost'));
ALTER TABLE public.qe_quotes DROP COLUMN IF EXISTS updated_at;
ALTER TABLE public.qe_quotes DROP COLUMN IF EXISTS client_note;

COMMIT;
