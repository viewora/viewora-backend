-- One-click unsubscribe from non-essential emails (nudge, weekly digest,
-- monthly report). Set by POST /email/unsubscribe; the cron jobs skip users
-- where this is not null. Billing and account emails ignore it.
--
-- Run in the Supabase SQL editor before deploying the backend that uses it.
-- (The crons tolerate the column being missing, but unsubscribing will fail.)

alter table public.profiles
  add column if not exists marketing_emails_opted_out_at timestamptz;
