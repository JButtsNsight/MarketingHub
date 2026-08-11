-- cdk/sql/2026-08-11-recipient-timezones.sql
-- MarketingHub — per-recipient send timezones. Contact-list members carry an
-- optional zone (a CSV `timezone` column, or a per-list configured Monday
-- timezone column), and outbox rows record the zone their send_after was
-- computed in (audit + reschedule recompute), CHECK-constrained to the five
-- US send zones (the reschedule sweep's closed candidate set). Every column
-- is nullable and null means "fall back to the campaign zone" — zoneless
-- lists behave exactly as before this migration. A per-campaign zone-counts
-- view aggregates the "N zones" chips SQL-side.
-- IDEMPOTENT: safe to re-run. Never destructive (no DROP).
--
-- Zone normalization (IANA ids + ET/CT/MT/PT/HT abbreviations → the US send
-- zones, unknown → campaign-zone fallback) happens app-side at campaign
-- creation (web/src/lib/sms/timezone.ts); the member column keeps what the
-- upload/board provided. The claim RPC is untouched — dispatch is already
-- send_after-driven, so per-zone instants need no worker changes.
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema, and the new columns are invisible until it reloads.

-- csv lists: the sheet's timezone column, verbatim as uploaded.
alter table marketinghub.contact_list_members
  add column if not exists timezone text;

-- monday lists: which board column carries the recipient timezone (optional,
-- picked in the list-create form alongside the phone column).
alter table marketinghub.contact_lists
  add column if not exists monday_timezone_column_id text;

-- outbox rows: the zone this row's send_after was computed in; null on rows
-- created before per-recipient zones (they used the campaign zone).
alter table marketinghub.sms_campaign_recipients
  add column if not exists send_timezone text;

-- The app normalizes send_timezone to the SEND_TIMEZONE_IDS enum before every
-- insert, and getPendingRecipientZones / rescheduleCampaign probe EXACTLY
-- that closed set + null. This CHECK makes the closed-set assumption real
-- against out-of-band writes (the /sql console runs as the DB superuser —
-- CHECK constraints bind superusers, unlike RLS): a row with a value outside
-- the set would silently belong to NO reschedule sweep group and keep its
-- original send_after forever. Named + guarded, so re-runs are no-ops.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname  = 'sms_campaign_recipients_send_timezone_check'
      and conrelid = 'marketinghub.sms_campaign_recipients'::regclass
  ) then
    alter table marketinghub.sms_campaign_recipients
      add constraint sms_campaign_recipients_send_timezone_check
      check (send_timezone is null or send_timezone in (
        'America/New_York',
        'America/Chicago',
        'America/Denver',
        'America/Los_Angeles',
        'Pacific/Honolulu'
      ));
  end if;
end $$;

-- Zone spread per campaign × zone, aggregated SQL-side for the "N zones"
-- chips (the alternative — paging raw (campaign_id, send_timezone) rows —
-- costs O(every zoned recipient ever) per /campaigns render and only grows).
-- Mirrors sms_campaign_recipient_counts: security_invoker, so authenticated
-- reads run under sms_campaign_recipients' own RLS.
create or replace view marketinghub.sms_campaign_recipient_zone_counts
  with (security_invoker = true) as
select campaign_id, send_timezone, count(*)::int as count
from marketinghub.sms_campaign_recipients
group by campaign_id, send_timezone;

-- Same grant posture as the w4 view grants (anon/public never read views).
revoke all on marketinghub.sms_campaign_recipient_zone_counts
  from anon, authenticated, public;
grant select on marketinghub.sms_campaign_recipient_zone_counts
  to authenticated;

-- ---------------------------------------------------------------------------
-- PRIVILEGES — service_role is the ONLY role that touches this schema
-- (idempotent re-assert, order-independent from the earlier migrations).
-- ---------------------------------------------------------------------------
grant usage on schema marketinghub to service_role;
grant all privileges on all tables in schema marketinghub to service_role;
alter default privileges in schema marketinghub
  grant all privileges on tables to service_role;

-- ---------------------------------------------------------------------------
-- DENY-BY-DEFAULT RLS (spec §12) — same pattern as every marketinghub table:
-- ENABLE + FORCE + explicit RESTRICTIVE deny-all for anon/authenticated,
-- re-asserted on the tables this migration touches. service_role (BYPASSRLS)
-- is unaffected.
-- ---------------------------------------------------------------------------
alter table marketinghub.contact_list_members enable row level security;
alter table marketinghub.contact_list_members force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'contact_list_members'
      and policyname = 'contact_list_members_deny_all'
  ) then
    create policy contact_list_members_deny_all on marketinghub.contact_list_members
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

alter table marketinghub.contact_lists enable row level security;
alter table marketinghub.contact_lists force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'contact_lists'
      and policyname = 'contact_lists_deny_all'
  ) then
    create policy contact_lists_deny_all on marketinghub.contact_lists
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

alter table marketinghub.sms_campaign_recipients enable row level security;
alter table marketinghub.sms_campaign_recipients force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_campaign_recipients'
      and policyname = 'sms_campaign_recipients_deny_all'
  ) then
    create policy sms_campaign_recipients_deny_all on marketinghub.sms_campaign_recipients
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;
