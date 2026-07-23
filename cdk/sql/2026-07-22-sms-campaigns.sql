-- cdk/sql/2026-07-22-sms-campaigns.sql
-- MarketingHub — SMS campaigns outbox schema (Monday.com lists -> SimpleTexting).
-- IDEMPOTENT: safe to re-run. Never destructive (no DROP).
-- Four tables (campaigns, recipients outbox, STOP suppressions, webhook events),
-- a per-campaign status-counts view, and the claim_due_sms_recipients() RPC
-- (FOR UPDATE SKIP LOCKED row claiming for the dispatcher worker). Only the app
-- server + dispatcher (service_role via PostgREST) touch this schema — never
-- the browser. Cognito is the sole auth.
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema, and the new tables/RPC 404 until it reloads.

create schema if not exists marketinghub;

-- gen_random_uuid() comes from pgcrypto (present by default on Supabase Postgres).
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- sms_campaigns — one row per scheduled campaign. `message_body` snapshots the
-- template at creation time; `send_at` is the precomputed UTC instant of
-- 11:30 America/New_York on `send_date` (DST-aware, computed by the app).
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_campaigns (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  template_id            uuid not null references marketinghub.templates(id),
  monday_board_id        text not null,
  monday_phone_column_id text not null,
  message_body           text not null,
  send_date              date not null,
  send_at                timestamptz not null,
  status                 text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'paused', 'completed', 'canceled')),
  created_by             text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Dispatcher promotion query: scheduled campaigns whose send_at is due.
create index if not exists sms_campaigns_status_send_at_idx
  on marketinghub.sms_campaigns (status, send_at);

-- ---------------------------------------------------------------------------
-- sms_campaign_recipients — the durable outbox: one row per recipient.
-- `rendered_text` is the per-recipient merge-field snapshot (audit trail).
-- `attempts` counts POST attempts STARTED (incremented on claimed -> sending).
-- `send_after` starts at the campaign's send_at; retry backoff bumps it.
-- Duplicate/invalid rows are kept for audit as `skipped` and MUST carry
-- phone_e164 = null (raw phone noted in last_error) — nulls are distinct, so
-- they never trip the unique (campaign_id, phone_e164) constraint.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_campaign_recipients (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references marketinghub.sms_campaigns(id) on delete cascade,
  monday_item_id   text,
  name             text,
  first_name       text,
  phone_e164       text,
  rendered_text    text not null,
  status           text not null default 'pending'
    check (status in ('pending', 'claimed', 'sending', 'sent', 'delivered',
                      'undelivered', 'failed', 'failed_ambiguous', 'suppressed',
                      'skipped', 'canceled')),
  attempts         int not null default 0,
  send_after       timestamptz not null,
  claimed_at       timestamptz,
  claim_expires_at timestamptz,
  st_message_id    text,
  st_credits       int,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (campaign_id, phone_e164)
);

-- Claim RPC step 4: due pending rows, oldest first.
create index if not exists sms_campaign_recipients_due_idx
  on marketinghub.sms_campaign_recipients (send_after)
  where status = 'pending';

-- Claim RPC steps 2/3: crash recovery scans for expired claims.
create index if not exists sms_campaign_recipients_expiry_idx
  on marketinghub.sms_campaign_recipients (claim_expires_at)
  where status in ('claimed', 'sending');

-- Campaign detail page + counts view.
create index if not exists sms_campaign_recipients_campaign_id_idx
  on marketinghub.sms_campaign_recipients (campaign_id);

-- Delivery-report webhook reconciliation by SimpleTexting message id.
create index if not exists sms_campaign_recipients_st_message_id_idx
  on marketinghub.sms_campaign_recipients (st_message_id);

-- Phone lookups: webhook fallback matching + STOP fan-out across campaigns.
create index if not exists sms_campaign_recipients_phone_e164_idx
  on marketinghub.sms_campaign_recipients (phone_e164);

-- ---------------------------------------------------------------------------
-- sms_suppressions — permanent STOP list. Enforced at campaign creation, in
-- the claim RPC (step 1), and pre-send in the dispatcher. Never expires.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_suppressions (
  phone_e164 text primary key,
  reason     text not null check (reason in ('stop', 'manual')),
  raw        jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- sms_webhook_events — raw audit of EVERY SimpleTexting webhook request
-- (payload shapes are undocumented; the tolerant parser classifies, this
-- table keeps the evidence for post-launch heuristic tuning).
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_webhook_events (
  id                   uuid primary key default gen_random_uuid(),
  received_at          timestamptz not null default now(),
  kind                 text not null check (kind in ('unsubscribe', 'delivery_report', 'unknown')),
  raw                  jsonb not null,
  matched_recipient_id uuid references marketinghub.sms_campaign_recipients(id)
);

-- ---------------------------------------------------------------------------
-- Counts view — campaign_id x status x count for list/detail pages.
-- security_invoker = true: the view runs with the CALLER's privileges, so the
-- deny-all RLS on the underlying table still blanks it for anon/authenticated
-- (a default security-definer view would leak through as the view owner).
-- ---------------------------------------------------------------------------
create or replace view marketinghub.sms_campaign_recipient_counts
  with (security_invoker = true) as
select campaign_id, status, count(*)::int as count
from marketinghub.sms_campaign_recipients
group by campaign_id, status;

-- ---------------------------------------------------------------------------
-- Claim RPC — the dispatcher's single entry point for taking work. PostgREST
-- cannot express FOR UPDATE SKIP LOCKED, so row claiming lives here. Four
-- steps, in order:
--   1. due pending rows whose phone joined the STOP list -> suppressed;
--   2. expired `claimed` rows -> pending (no POST was started: the attempts
--      counter only increments on claimed -> sending, so retrying is provably
--      duplicate-free);
--   3. expired `sending` rows -> failed_ambiguous (a POST may have landed;
--      NEVER auto-retried — a duplicate patient text is worse than a missed
--      one; webhook reconciliation or manual review resolves it);
--   4. claim due pending rows from campaigns actively `sending`, oldest
--      send_after first, SKIP LOCKED so overlapping dispatchers never fight.
-- ---------------------------------------------------------------------------
create or replace function marketinghub.claim_due_sms_recipients(
  batch_size int default 25,
  claim_ttl_seconds int default 180
) returns setof marketinghub.sms_campaign_recipients
language plpgsql
security invoker
as $$
begin
  -- Step 1: suppression sweep over due pending rows.
  update marketinghub.sms_campaign_recipients r
     set status     = 'suppressed',
         updated_at = now()
   where r.status = 'pending'
     and r.send_after <= now()
     and exists (
       select 1 from marketinghub.sms_suppressions s
       where s.phone_e164 = r.phone_e164
     );

  -- Step 2: expired claims (no POST started) safely return to pending.
  update marketinghub.sms_campaign_recipients r
     set status           = 'pending',
         claimed_at       = null,
         claim_expires_at = null,
         updated_at       = now()
   where r.status = 'claimed'
     and r.claim_expires_at <= now();

  -- Step 3: expired sending rows are ambiguous — park for reconciliation.
  update marketinghub.sms_campaign_recipients r
     set status     = 'failed_ambiguous',
         last_error = coalesce(r.last_error, 'claim expired while sending'),
         updated_at = now()
   where r.status = 'sending'
     and r.claim_expires_at <= now();

  -- Step 4: claim a batch of due pending rows from sending campaigns.
  return query
  with due as (
    select r.id
    from marketinghub.sms_campaign_recipients r
    join marketinghub.sms_campaigns c on c.id = r.campaign_id
    where r.status = 'pending'
      and r.send_after <= now()
      and c.status = 'sending'
    order by r.send_after
    limit batch_size
    for update of r skip locked
  )
  update marketinghub.sms_campaign_recipients r
     set status           = 'claimed',
         claimed_at       = now(),
         claim_expires_at = now() + make_interval(secs => claim_ttl_seconds),
         updated_at       = now()
    from due
   where r.id = due.id
  returning r.*;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default — this revoke
-- is LOAD-BEARING: without it anon/authenticated could claim outbox rows
-- through PostgREST. service_role (the dispatcher) is the only caller.
revoke execute on function marketinghub.claim_due_sms_recipients(int, int)
  from public, anon, authenticated;
grant execute on function marketinghub.claim_due_sms_recipients(int, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- PRIVILEGES — service_role is the ONLY role that touches this schema.
-- Re-asserted here (idempotent) so this migration is order-independent from
-- 2026-07-05-templates.sql; the default-privileges rule covers the new tables
-- when the migration role matches, and the explicit grant covers them always.
-- ---------------------------------------------------------------------------
grant usage on schema marketinghub to service_role;
grant all privileges on all tables in schema marketinghub to service_role;
alter default privileges in schema marketinghub
  grant all privileges on tables to service_role;

-- ---------------------------------------------------------------------------
-- DENY-BY-DEFAULT RLS (spec §12) — `marketinghub` is exposed to PostgREST, so
-- the rls-gate hard-requires ENABLE + FORCE + an explicit RESTRICTIVE deny-all
-- policy on EVERY table. The application path is service_role (BYPASSRLS) and
-- is UNAFFECTED; anon/authenticated must get ZERO rows. FORCE does not apply
-- to the superuser postgres role, so migrations/pg_dump are unaffected.
-- Policy creation is do-block-guarded (DROP-free, idempotent).
-- ---------------------------------------------------------------------------
alter table marketinghub.sms_campaigns enable row level security;
alter table marketinghub.sms_campaigns force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_campaigns'
      and policyname = 'sms_campaigns_deny_all'
  ) then
    create policy sms_campaigns_deny_all on marketinghub.sms_campaigns
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

alter table marketinghub.sms_suppressions enable row level security;
alter table marketinghub.sms_suppressions force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_suppressions'
      and policyname = 'sms_suppressions_deny_all'
  ) then
    create policy sms_suppressions_deny_all on marketinghub.sms_suppressions
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

alter table marketinghub.sms_webhook_events enable row level security;
alter table marketinghub.sms_webhook_events force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_webhook_events'
      and policyname = 'sms_webhook_events_deny_all'
  ) then
    create policy sms_webhook_events_deny_all on marketinghub.sms_webhook_events
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;
