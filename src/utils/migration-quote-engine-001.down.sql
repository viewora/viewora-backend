-- Rollback for migration-quote-engine-001.sql. Drops every quote-engine
-- table and the data in it. Existing Viewora tables are not touched.

BEGIN;

DROP TABLE IF EXISTS
  public.qe_audit_log,
  public.qe_notes,
  public.qe_messages,
  public.qe_sequences,
  public.qe_message_templates,
  public.qe_payments,
  public.qe_job_costs,
  public.qe_jobs,
  public.qe_quote_lines,
  public.qe_quote_options,
  public.qe_quotes,
  public.qe_quote_requests,
  public.qe_entry_links,
  public.qe_rate_items,
  public.qe_rate_tables,
  public.qe_leads,
  public.qe_consent_texts,
  public.qe_partners,
  public.qe_staff
CASCADE;

COMMIT;
