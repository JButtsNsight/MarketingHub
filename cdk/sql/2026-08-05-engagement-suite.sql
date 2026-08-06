-- cdk/sql/2026-08-05-engagement-suite.sql
-- MarketingHub — engagement suite: per-recipient tracked short links + click
-- events, the inbound-reply inbox, suppression management (manual add/remove
-- with an audit trail), consent provenance on contact-list members, and an
-- optional dispatcher frequency cap.
-- IDEMPOTENT: safe to re-run. Never destructive to DATA (the only DROPs are
-- constraint/function redefinitions immediately re-created below them).
--
-- ORDER MATTERS: this file redefines claim_due_sms_recipients with two new
-- (defaulted) frequency-cap parameters. 2026-07-22-sms-campaigns.sql still
-- creates the old 2-arg version; re-running the suite must apply THIS file
-- last or the two overloads coexist and PostgREST RPC resolution turns
-- ambiguous. The runbook applies migrations in filename order — keep it so.
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema, and the new tables/RPC signature 404 until it reloads.

create schema if not exists marketinghub;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- sms_links — one row per (recipient × URL) tracked short link. Slugs are
-- app-generated (crypto-random base62) and embedded into the recipient's
-- rendered_text at campaign-creation time as `<LINK_BASE_URL>/l/<slug>`;
-- the /l/[slug] route resolves them and 302s to target_url. Per-recipient
-- rows are what make click-through attributable to a person.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_links (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  campaign_id  uuid not null references marketinghub.sms_campaigns(id) on delete cascade,
  recipient_id uuid not null references marketinghub.sms_campaign_recipients(id) on delete cascade,
  target_url   text not null,
  created_at   timestamptz not null default now()
);

create index if not exists sms_links_campaign_id_idx
  on marketinghub.sms_links (campaign_id);
create index if not exists sms_links_recipient_id_idx
  on marketinghub.sms_links (recipient_id);

-- ---------------------------------------------------------------------------
-- sms_link_clicks — one row per redirect served. Deliberately minimal: the
-- user agent is kept for bot-vs-human triage, no IP address is stored.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_link_clicks (
  id         uuid primary key default gen_random_uuid(),
  link_id    uuid not null references marketinghub.sms_links(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  user_agent text
);

create index if not exists sms_link_clicks_link_id_idx
  on marketinghub.sms_link_clicks (link_id);

-- ---------------------------------------------------------------------------
-- sms_inbound_messages — the reply inbox. Populated by the SimpleTexting
-- webhook's new `inbound` lane; matched best-effort to the newest outbox row
-- for the phone (so replies land on the campaign that prompted them).
-- `handled` is the inbox workflow bit (who cleared it, when).
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_inbound_messages (
  id                   uuid primary key default gen_random_uuid(),
  phone_e164           text,
  body                 text not null default '',
  received_at          timestamptz not null default now(),
  matched_recipient_id uuid references marketinghub.sms_campaign_recipients(id),
  matched_campaign_id  uuid references marketinghub.sms_campaigns(id),
  handled              boolean not null default false,
  handled_by           text,
  handled_at           timestamptz,
  raw                  jsonb not null
);

create index if not exists sms_inbound_messages_received_at_idx
  on marketinghub.sms_inbound_messages (received_at desc);
-- Inbox badge: count of unhandled rows.
create index if not exists sms_inbound_messages_unhandled_idx
  on marketinghub.sms_inbound_messages (received_at desc)
  where handled = false;
create index if not exists sms_inbound_messages_campaign_idx
  on marketinghub.sms_inbound_messages (matched_campaign_id);
create index if not exists sms_inbound_messages_phone_idx
  on marketinghub.sms_inbound_messages (phone_e164);

-- ---------------------------------------------------------------------------
-- sms_suppression_audit — who added/removed suppression entries by hand and
-- why (TCPA evidence). Webhook STOP additions are NOT duplicated here — the
-- raw webhook row in sms_webhook_events is already their audit trail.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.sms_suppression_audit (
  id         uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  action     text not null check (action in ('added', 'removed')),
  reason     text not null,
  actor      text not null,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists sms_suppression_audit_phone_idx
  on marketinghub.sms_suppression_audit (phone_e164);

-- ---------------------------------------------------------------------------
-- Consent provenance on contact-list members — captured verbatim from the
-- uploaded sheet when it carries consent columns (source + date). Stored as
-- the raw strings the uploader provided: this is audit evidence of what was
-- claimed at import time, not computed data, so no date parsing.
-- ---------------------------------------------------------------------------
alter table marketinghub.contact_list_members
  add column if not exists consent_source text;
alter table marketinghub.contact_list_members
  add column if not exists consent_date text;

-- ---------------------------------------------------------------------------
-- Webhook events learn the `inbound` kind (incoming replies).
-- Drop/re-add is the idempotent way to widen a CHECK; the new set is a
-- superset of the old, so existing rows always revalidate.
-- ---------------------------------------------------------------------------
alter table marketinghub.sms_webhook_events
  drop constraint if exists sms_webhook_events_kind_check;
alter table marketinghub.sms_webhook_events
  add constraint sms_webhook_events_kind_check
  check (kind in ('unsubscribe', 'delivery_report', 'inbound', 'unknown'));

-- ---------------------------------------------------------------------------
-- Recipients learn the `frequency_capped` terminal status (see the RPC
-- below). Same superset drop/re-add.
-- ---------------------------------------------------------------------------
alter table marketinghub.sms_campaign_recipients
  drop constraint if exists sms_campaign_recipients_status_check;
alter table marketinghub.sms_campaign_recipients
  add constraint sms_campaign_recipients_status_check
  check (status in ('pending', 'claimed', 'sending', 'sent', 'delivered',
                    'undelivered', 'failed', 'failed_ambiguous', 'suppressed',
                    'skipped', 'canceled', 'frequency_capped'));

-- ---------------------------------------------------------------------------
-- Claim RPC v2 — same four steps as 2026-07-22, plus an OPTIONAL frequency
-- cap. Defaults 0/0 disable it entirely: behavior is then IDENTICAL to the
-- old function. With the cap on (both params > 0):
--
--   step 3.5  terminally parks due pending rows as `frequency_capped` when
--             the phone already has >= freq_cap_count SETTLED sends
--             (sent/delivered/undelivered) inside the window. It runs AFTER
--             crash recovery (steps 2/3) so rows just released back to
--             pending are evaluated too, and ONLY over campaigns actively
--             `sending` — a paused campaign's rows must be judged against
--             the window in force when they actually become claimable, not
--             today's. In-flight rows are deliberately NOT counted here: a
--             terminal decision cannot rest on a send that may still fail.
--   step 4    additionally claims at most ONE row per phone per batch and
--             skips phones that still have in-flight (`claimed`/`sending`)
--             rows — two campaigns hitting the same phone in the same slot
--             therefore serialize, and the second row is re-judged by the
--             sweep once the first settles. Worst case a row waits one extra
--             poll tick; a same-slot double-send cannot happen.
--
-- `coalesce(claimed_at, updated_at)` anchors "when it was sent" — claimed_at
-- survives the sent/delivered transitions, while updated_at is bumped by
-- late delivery reports.
--
-- The old 2-arg overload MUST be dropped first: PostgREST resolves RPCs by
-- named args, and a 2-named-arg call would match both overloads (22P02-style
-- ambiguity) if both exist.
-- ---------------------------------------------------------------------------
drop function if exists marketinghub.claim_due_sms_recipients(int, int);
drop function if exists marketinghub.claim_due_sms_recipients(int, int, int, int);

create function marketinghub.claim_due_sms_recipients(
  batch_size int default 25,
  claim_ttl_seconds int default 180,
  freq_cap_count int default 0,
  freq_cap_days int default 0
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

  if freq_cap_count > 0 and freq_cap_days > 0 then
    -- Step 3.5: frequency-cap sweep (see header). Terminal by design — a
    -- capped blast message days late is worse than not sending it.
    update marketinghub.sms_campaign_recipients r
       set status     = 'frequency_capped',
           last_error = format(
             'frequency cap: phone already received %s message(s) in the last %s day(s)',
             freq_cap_count, freq_cap_days),
           updated_at = now()
     where r.status = 'pending'
       and r.send_after <= now()
       and exists (
         select 1 from marketinghub.sms_campaigns c
         where c.id = r.campaign_id
           and c.status = 'sending'
       )
       and (
         select count(*)
           from marketinghub.sms_campaign_recipients h
          where h.phone_e164 = r.phone_e164
            and h.id <> r.id
            and h.status in ('sent', 'delivered', 'undelivered')
            and coalesce(h.claimed_at, h.updated_at)
                  >= now() - make_interval(days => freq_cap_days)
       ) >= freq_cap_count;

    -- Step 4 (cap on): one row per phone per batch, no phones with rows
    -- still in flight. The window function cannot share a query level with
    -- FOR UPDATE, so ranking happens in a plain CTE and the locking SELECT
    -- re-reads the base table (re-checking status/due under the lock).
    return query
    with ranked as (
      select r2.id,
             r2.phone_e164,
             r2.send_after,
             row_number() over (
               partition by r2.phone_e164
               order by r2.send_after, r2.id
             ) as phone_rank
      from marketinghub.sms_campaign_recipients r2
      join marketinghub.sms_campaigns c on c.id = r2.campaign_id
      where r2.status = 'pending'
        and r2.send_after <= now()
        and c.status = 'sending'
    ),
    due as (
      select r3.id
      from marketinghub.sms_campaign_recipients r3
      join ranked rk on rk.id = r3.id
      where rk.phone_rank = 1
        and r3.status = 'pending'
        and r3.send_after <= now()
        and not exists (
          select 1 from marketinghub.sms_campaign_recipients f
          where f.phone_e164 = rk.phone_e164
            and f.status in ('claimed', 'sending')
        )
      order by rk.send_after
      limit batch_size
      for update of r3 skip locked
    )
    update marketinghub.sms_campaign_recipients r
       set status           = 'claimed',
           claimed_at       = now(),
           claim_expires_at = now() + make_interval(secs => claim_ttl_seconds),
           updated_at       = now()
      from due
     where r.id = due.id
    returning r.*;
  else
    -- Step 4 (cap off): identical to the pre-cap function.
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
  end if;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default — this revoke
-- is LOAD-BEARING: without it anon/authenticated could claim outbox rows
-- through PostgREST. service_role (the dispatcher) is the only caller.
revoke execute on function marketinghub.claim_due_sms_recipients(int, int, int, int)
  from public, anon, authenticated;
grant execute on function marketinghub.claim_due_sms_recipients(int, int, int, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- Engagement view — one row per campaign with the click/reply/opt-out
-- aggregates the analytics pages read. Opt-outs are attributed to a campaign
-- when a messaged phone joined the STOP list after that campaign's send_at
-- (a phone messaged by two campaigns counts against both — documented
-- over-attribution, better than losing the signal).
-- security_invoker = true: same load-bearing reason as the counts view — the
-- deny-all RLS on the underlying tables must still blank it for anon/
-- authenticated.
-- ---------------------------------------------------------------------------
create or replace view marketinghub.sms_campaign_engagement
  with (security_invoker = true) as
select
  c.id as campaign_id,
  (select count(*)::int
     from marketinghub.sms_links l
    where l.campaign_id = c.id) as tracked_links,
  (select count(distinct l.recipient_id)::int
     from marketinghub.sms_links l
     join marketinghub.sms_link_clicks k on k.link_id = l.id
    where l.campaign_id = c.id) as recipients_clicked,
  (select count(*)::int
     from marketinghub.sms_link_clicks k
     join marketinghub.sms_links l on l.id = k.link_id
    where l.campaign_id = c.id) as total_clicks,
  (select count(*)::int
     from marketinghub.sms_inbound_messages m
    where m.matched_campaign_id = c.id) as replies,
  (select count(*)::int
     from marketinghub.sms_inbound_messages m
    where m.matched_campaign_id = c.id
      and m.handled = false) as unhandled_replies,
  (select count(distinct r.phone_e164)::int
     from marketinghub.sms_campaign_recipients r
     join marketinghub.sms_suppressions s on s.phone_e164 = r.phone_e164
    where r.campaign_id = c.id
      and r.status in ('sent', 'delivered', 'undelivered')
      and s.created_at >= c.send_at) as opt_outs
from marketinghub.sms_campaigns c;

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
-- ENABLE + FORCE + explicit RESTRICTIVE deny-all for anon/authenticated.
-- service_role (BYPASSRLS) is unaffected.
-- ---------------------------------------------------------------------------
alter table marketinghub.sms_links enable row level security;
alter table marketinghub.sms_links force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_links'
      and policyname = 'sms_links_deny_all'
  ) then
    create policy sms_links_deny_all on marketinghub.sms_links
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

alter table marketinghub.sms_link_clicks enable row level security;
alter table marketinghub.sms_link_clicks force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_link_clicks'
      and policyname = 'sms_link_clicks_deny_all'
  ) then
    create policy sms_link_clicks_deny_all on marketinghub.sms_link_clicks
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

alter table marketinghub.sms_inbound_messages enable row level security;
alter table marketinghub.sms_inbound_messages force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_inbound_messages'
      and policyname = 'sms_inbound_messages_deny_all'
  ) then
    create policy sms_inbound_messages_deny_all on marketinghub.sms_inbound_messages
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

alter table marketinghub.sms_suppression_audit enable row level security;
alter table marketinghub.sms_suppression_audit force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'sms_suppression_audit'
      and policyname = 'sms_suppression_audit_deny_all'
  ) then
    create policy sms_suppression_audit_deny_all on marketinghub.sms_suppression_audit
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;
