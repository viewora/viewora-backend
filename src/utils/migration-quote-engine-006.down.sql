-- Rollback for migration-quote-engine-006.sql.
-- Message and sequence rows are kept (they are the lead's history); only
-- what 006 added goes. Template versions saved in the editor after 006 are
-- kept; only the version-1 wording 006 seeded is removed. Audit rows stay.

BEGIN;

DROP FUNCTION IF EXISTS public.qe_fu_opt_out(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.qe_tpl_save(TEXT, TEXT, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.qe_fu_replied(TEXT);
DROP FUNCTION IF EXISTS public.qe_fu_stop(UUID, TEXT, TEXT[], UUID);
DROP FUNCTION IF EXISTS public.qe_fu_start(UUID, TEXT, UUID, SMALLINT, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.qe_fu_claim(TIMESTAMPTZ, INTEGER);

DELETE FROM public.qe_message_templates WHERE version = 1 AND key IN (
  'abandoned_resume', 'quote_ready', 'quote_nudge', 'quote_adjust', 'quote_expiry',
  'review_request', 'hosting_offer', 'renewal_reminder', 'staff_high_value'
);
DELETE FROM public.qe_settings WHERE key = 'messaging';

DROP TABLE IF EXISTS public.qe_resume_tokens;

DROP INDEX IF EXISTS public.qe_messages_week_idx;
DROP INDEX IF EXISTS public.qe_messages_tasks_idx;
ALTER TABLE public.qe_messages
  DROP COLUMN IF EXISTS done_at,
  DROP COLUMN IF EXISTS done_by,
  DROP COLUMN IF EXISTS needs_staff,
  DROP COLUMN IF EXISTS sequence_step;

DROP INDEX IF EXISTS public.qe_sequences_due_idx;
DROP INDEX IF EXISTS public.qe_sequences_active_uidx;
ALTER TABLE public.qe_sequences
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS stopped_at,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS subject_id;

COMMIT;
