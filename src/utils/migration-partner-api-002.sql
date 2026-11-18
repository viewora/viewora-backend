-- Partner API, migration 002: the partner pays for its agents.
-- Rollback: migration-partner-api-002.down.sql
--
-- Staff set the plan every agent gets, how long the partner has paid for,
-- and how many agents (seats) they paid for. Each agent then gets an
-- ordinary 'manual' subscription row (the same kind as "gift subscription")
-- that ends on paid_until, so existing plan limits and the daily expiry job
-- apply unchanged. Only api_partners changes; no existing table is altered.

BEGIN;

ALTER TABLE public.api_partners
  -- plans.id of the plan every agent gets. NULL = agents stay on Free.
  ADD COLUMN agent_plan_id TEXT,
  -- Agents' subscriptions end here; staff extend it when the partner pays.
  ADD COLUMN paid_until    TIMESTAMPTZ,
  -- Live agent seats paid for. NULL = no limit.
  ADD COLUMN max_agents    INTEGER CHECK (max_agents IS NULL OR max_agents >= 0);

COMMIT;
