-- Rollback for migration-quote-engine-002-seed.sql. Removes rate table v1
-- (its items cascade) and the seeded consent text, if no lead points at it.

BEGIN;
DELETE FROM public.qe_rate_tables WHERE version = 1;
DELETE FROM public.qe_consent_texts c
  WHERE c.body = 'Viewora can send me my quote and follow-ups on WhatsApp and email. I can stop them at any time by replying STOP.'
    AND NOT EXISTS (SELECT 1 FROM public.qe_leads l WHERE l.consent_text_id = c.id);
COMMIT;
