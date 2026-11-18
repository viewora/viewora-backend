-- Rollback for migration-partner-api-002.sql. Agents' subscription rows are
-- left as they are (they expire on their own at current_period_end).

BEGIN;

ALTER TABLE public.api_partners
  DROP COLUMN IF EXISTS max_agents,
  DROP COLUMN IF EXISTS paid_until,
  DROP COLUMN IF EXISTS agent_plan_id;

COMMIT;
