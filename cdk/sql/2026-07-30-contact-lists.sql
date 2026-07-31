-- cdk/sql/2026-07-30-contact-lists.sql
-- MarketingHub — reusable contact lists (CSV uploads + linked Monday boards)
-- and starter/dummy message templates.
-- IDEMPOTENT: safe to re-run. Never destructive (no DROP).
--
-- A contact list is a named, reusable recipient source for SMS campaigns:
--   source = 'csv'    — an uploaded sheet, parsed into contact_list_members
--                       (raw file kept in the private `contact-lists` bucket);
--   source = 'monday' — a saved Monday board + phone column; members are NOT
--                       stored — the board is fetched live at campaign creation
--                       exactly like the ad-hoc flow it replaces.
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema, and the new tables 404 until it reloads.

create schema if not exists marketinghub;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- contact_lists — one row per saved recipient source.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.contact_lists (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  source                 text not null check (source in ('csv', 'monday')),
  -- csv lists: the raw uploaded file in the private `contact-lists` bucket.
  storage_path           text,
  original_filename      text,
  -- monday lists: the saved board + phone column (fetched live at creation).
  monday_board_id        text,
  monday_board_name      text,
  monday_phone_column_id text,
  -- member classification counts (csv lists; monday lists stay 0 — live).
  contact_count          int not null default 0,
  invalid_count          int not null default 0,
  duplicate_count        int not null default 0,
  created_by             text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (
    (source = 'csv' and storage_path is not null)
    or
    (source = 'monday'
      and monday_board_id is not null
      and monday_phone_column_id is not null)
  )
);

-- ---------------------------------------------------------------------------
-- contact_list_members — parsed rows of a CSV list. Invalid/duplicate rows are
-- kept for audit with phone_e164 = null (nulls are distinct, so they never
-- trip the unique constraint) and the raw phone preserved in raw_phone.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.contact_list_members (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references marketinghub.contact_lists(id) on delete cascade,
  name       text not null default '',
  first_name text not null default '',
  phone_e164 text,
  raw_phone  text not null default '',
  reason     text not null default 'ok' check (reason in ('ok', 'invalid', 'duplicate')),
  created_at timestamptz not null default now(),
  unique (list_id, phone_e164)
);

create index if not exists contact_list_members_list_id_idx
  on marketinghub.contact_list_members (list_id);

-- ---------------------------------------------------------------------------
-- sms_campaigns learns its recipient source. Campaigns created from a CSV
-- list have no Monday coordinates, so the NOT NULLs relax (existing rows all
-- carry values; new monday-sourced campaigns still fill them from the list).
-- ---------------------------------------------------------------------------
alter table marketinghub.sms_campaigns
  add column if not exists contact_list_id uuid references marketinghub.contact_lists(id);

alter table marketinghub.sms_campaigns
  alter column monday_board_id drop not null;
alter table marketinghub.sms_campaigns
  alter column monday_phone_column_id drop not null;

create index if not exists sms_campaigns_contact_list_id_idx
  on marketinghub.sms_campaigns (contact_list_id);

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

-- ---------------------------------------------------------------------------
-- STARTER / DUMMY TEMPLATES — fixed UUIDs so the seed is idempotent
-- (`on conflict (id) do nothing`; edits made in the UI are never overwritten).
-- Text bodies use ONLY the supported merge fields ({{name}}, {{firstName}})
-- and are deliberately generic: SimpleTexting has no BAA, so NO PHI ever.
-- ---------------------------------------------------------------------------
insert into marketinghub.templates (id, name, type, category, tags, subject, body, created_by)
values
  ('a1000000-0000-4000-8000-000000000001', 'Wellness visit reminder', 'text', 'Announcement',
   '{reminder,wellness}', null,
   'Hi {{firstName}}, it''s time to schedule your next wellness visit. Call us or reply and we''ll help you find a time that works. Reply STOP to opt out.',
   'seed@marketinghub'),
  ('a1000000-0000-4000-8000-000000000002', 'August promotion', 'text', 'Promotion',
   '{promo,seasonal}', null,
   'Hi {{firstName}}! Our August special is here — mention this text at your next visit for 15% off select services. Reply STOP to opt out.',
   'seed@marketinghub'),
  ('a1000000-0000-4000-8000-000000000003', 'New patient welcome', 'text', 'Onboarding',
   '{welcome,onboarding}', null,
   'Welcome, {{firstName}}! We''re glad to have you with us. Save this number — we''ll text appointment reminders and news here. Reply STOP to opt out.',
   'seed@marketinghub'),
  ('a1000000-0000-4000-8000-000000000004', 'We miss you', 'text', 'Promotion',
   '{recall,winback}', null,
   'Hi {{firstName}}, it''s been a while since your last visit! Book anytime online or give us a call — we''d love to see you again. Reply STOP to opt out.',
   'seed@marketinghub'),
  ('a1000000-0000-4000-8000-000000000005', 'Holiday hours notice', 'text', 'Announcement',
   '{hours,holiday}', null,
   'Hi {{firstName}}, a quick note: our office hours change over the upcoming holiday. Check our website for the schedule. Reply STOP to opt out.',
   'seed@marketinghub'),
  ('a1000000-0000-4000-8000-000000000006', 'Referral thank-you', 'text', 'Transactional',
   '{referral,thanks}', null,
   'Thank you, {{name}}, for recommending us to your friends and family — it means a lot. Reply STOP to opt out.',
   'seed@marketinghub'),
  ('a1000000-0000-4000-8000-000000000007', 'Monthly newsletter', 'email', 'Newsletter',
   '{newsletter,monthly}', 'Your monthly update from the practice',
   E'Hi {{firstName}},\n\nHere''s what''s new this month at the practice: new services, team news, and health tips picked by our staff.\n\nWe''ll see you soon!\nThe Team',
   'seed@marketinghub'),
  ('a1000000-0000-4000-8000-000000000008', 'Event invitation', 'email', 'Announcement',
   '{event,invite}', 'You''re invited: community health day',
   E'Hi {{firstName}},\n\nJoin us for our community health day — free screenings, giveaways, and Q&A with the team. Bring a friend!\n\nRSVP by replying to this email.',
   'seed@marketinghub')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- PRIVATE STORAGE BUCKET (applied alongside this migration — psql as postgres
-- may write the storage schema directly; same pattern as campaign-templates):
--
--   insert into storage.buckets (id, name, public)
--   values ('contact-lists', 'contact-lists', false)
--   on conflict (id) do nothing;
--
-- Do NOT mark this bucket public.
