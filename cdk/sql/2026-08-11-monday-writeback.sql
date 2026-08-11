-- cdk/sql/2026-08-11-monday-writeback.sql
-- MarketingHub — Monday outcome write-back foundation. Lists gain a per-list
-- configured outcome column; outbox rows gain a sync watermark (when + what
-- outcome was last written to Monday). The write-back worker re-writes a row
-- only when its current outcome differs from the synced snapshot — that
-- comparison is the idempotency contract, so outcomes that arrive late
-- (delivery reports, replies, opt-outs) converge without duplicate writes.
-- Every column is nullable: CSV campaigns (monday_board_id null) and rows
-- without a monday_item_id are simply never synced. The w5 recipients
-- realtime trigger is split (see below) so watermark bumps stop broadcasting.
-- IDEMPOTENT: safe to re-run. Never destructive of data (the one DROP is a
-- trigger, re-created split inside the same atomic do-block).
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema, and the new columns are invisible until it reloads.

-- monday lists: which board column receives the campaign outcome (optional,
-- picked in the list-create form alongside the phone column).
alter table marketinghub.contact_lists
  add column if not exists monday_outcome_column_id text;

-- outbox rows: the write-back watermark. monday_synced_at = the last instant
-- the row was CHECKED (confirmed write, verified no-op, or failed attempt —
-- the bump is the round-robin's liveness, lib/monday/writebackRepo.ts);
-- monday_synced_status = the outcome value Monday last CONFIRMED holding
-- (compared against the current outcome — the idempotency contract).
alter table marketinghub.sms_campaign_recipients
  add column if not exists monday_synced_at timestamptz;
alter table marketinghub.sms_campaign_recipients
  add column if not exists monday_synced_status text;

-- ---------------------------------------------------------------------------
-- W5 realtime-trigger interplay — watermark bumps are bookkeeping, not news.
-- 2026-08-08-w5-realtime.sql created sms_campaign_recipients_mh_notify on
-- EVERY insert/update with no column filter; the write-back round-robin bumps
-- monday_synced_at on up to `batch` rows every poll FOREVER (verified no-ops
-- included), which would broadcast a permanent stream of mh:campaigns /
-- mh:campaign:<id> 'change' events — and re-render any open campaign detail
-- page (LiveRefresher) — while nothing visible changed. Split the trigger:
-- INSERTs broadcast unconditionally as before; UPDATEs broadcast only when
-- something OTHER than the two watermark columns changed (the jsonb-minus
-- comparison stays correct as columns are added later). Atomic: the drop and
-- both creates run inside one do-block (a single-statement transaction), so
-- no window exists with no trigger in place. Idempotent: re-runs no-op, and
-- re-applying w5 later just re-creates the old trigger for this block to
-- split again.
do $$
begin
  drop trigger if exists sms_campaign_recipients_mh_notify
    on marketinghub.sms_campaign_recipients;

  if not exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'marketinghub'
       and c.relname = 'sms_campaign_recipients'
       and t.tgname  = 'sms_campaign_recipients_mh_notify_ins'
  ) then
    create trigger sms_campaign_recipients_mh_notify_ins
      after insert on marketinghub.sms_campaign_recipients
      for each row execute function marketinghub.tg_mh_notify('campaigns');
  end if;

  if not exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'marketinghub'
       and c.relname = 'sms_campaign_recipients'
       and t.tgname  = 'sms_campaign_recipients_mh_notify_upd'
  ) then
    create trigger sms_campaign_recipients_mh_notify_upd
      after update on marketinghub.sms_campaign_recipients
      for each row
      when (
        (to_jsonb(old) - 'monday_synced_at' - 'monday_synced_status')
        is distinct from
        (to_jsonb(new) - 'monday_synced_at' - 'monday_synced_status')
      )
      execute function marketinghub.tg_mh_notify('campaigns');
  end if;
end $$;

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
