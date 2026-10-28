-- Rollback for migration-quote-engine-007.sql.
-- Payout records are money history: the rollback refuses to run while any
-- exist, so export the commission report first and delete them on purpose.
-- Links keep their rows (requests point at them); only 007's columns go.
-- Audit rows stay.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.qe_partner_payouts) THEN
    RAISE EXCEPTION 'qe_partner_payouts has rows; export and remove them before rolling back 007';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.qe_partner_payouts_record(JSONB, TEXT, UUID);
DROP FUNCTION IF EXISTS public.qe_commission_jobs(UUID);
DROP FUNCTION IF EXISTS public.qe_partner_save(UUID, JSONB, UUID);
DROP FUNCTION IF EXISTS public.qe_partner_list();
DROP FUNCTION IF EXISTS public.qe_partner_credit(UUID, TEXT);
DROP FUNCTION IF EXISTS public.qe_link_attach(TEXT, UUID);
DROP FUNCTION IF EXISTS public.qe_link_revoke(UUID, UUID);
DROP FUNCTION IF EXISTS public.qe_link_list(TEXT, UUID);
DROP FUNCTION IF EXISTS public.qe_link_use(TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.qe_link_get(TEXT);
DROP FUNCTION IF EXISTS public.qe_link_create(TEXT, TEXT, TEXT, JSONB, UUID, UUID, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.qe_link_row(UUID);

DROP TABLE IF EXISTS public.qe_partner_payouts;
DROP INDEX IF EXISTS public.qe_leads_partner_idx;
ALTER TABLE public.qe_partners DROP COLUMN IF EXISTS updated_at;

DROP INDEX IF EXISTS public.qe_entry_links_created_idx;
DROP INDEX IF EXISTS public.qe_entry_links_lead_idx;
DROP INDEX IF EXISTS public.qe_entry_links_id_uidx;
ALTER TABLE public.qe_entry_links
  DROP COLUMN IF EXISTS revoked_by,
  DROP COLUMN IF EXISTS revoked_at,
  DROP COLUMN IF EXISTS label,
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS id;

COMMIT;
