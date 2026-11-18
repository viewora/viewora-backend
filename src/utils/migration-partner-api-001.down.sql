-- Rollback for migration-partner-api-001.sql. Drops the partner API tables.
-- Agent accounts (auth.users) and their tours (properties) are NOT deleted:
-- they stay as normal Viewora accounts. Existing tables are not touched.

BEGIN;

DROP TABLE IF EXISTS
  public.api_partner_tours,
  public.api_partner_agents,
  public.api_partner_keys,
  public.api_partners;

COMMIT;
