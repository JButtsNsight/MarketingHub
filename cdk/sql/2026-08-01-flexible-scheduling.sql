-- cdk/sql/2026-08-01-flexible-scheduling.sql
-- MarketingHub — flexible blast scheduling: campaigns carry their chosen
-- 30-minute slot and US send zone alongside the computed send_at instant.
-- IDEMPOTENT: safe to re-run. Never destructive (no DROP).
--
-- The defaults backfill every pre-scheduling campaign with the fixed slot
-- they were actually created under (11:30 AM America/New_York).
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema, and the new columns are invisible until it reloads.

alter table marketinghub.sms_campaigns
  add column if not exists send_time text not null default '11:30';

alter table marketinghub.sms_campaigns
  add column if not exists send_timezone text not null default 'America/New_York';
