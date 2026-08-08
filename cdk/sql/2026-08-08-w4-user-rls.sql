-- cdk/sql/2026-08-08-w4-user-rls.sql
-- Supabase parity — Wave 4: per-user JWTs + real RLS for role `authenticated`.
-- Opens the user-facing marketinghub tables to `authenticated` per the Wave-4
-- policy matrix (permissive USING(true)/WITH CHECK(true) per permitted op —
-- no row ownership exists, so op-level access IS the model; never invent
-- user_id), re-scopes the RESTRICTIVE deny-all policies on those tables to
-- `anon` only, adds the console_impersonation_audit table (service-only), and
-- stages the GoTrue custom-access-token hook stub for the Wave-3 cutover.
-- IDEMPOTENT: safe to re-run. Never destructive.
--
-- NON-BREAKING BY CONSTRUCTION: nothing here changes behavior while the app
-- rides service_role (BYPASSRLS — policies and grants for `authenticated` are
-- invisible to it). The `authenticated` path only activates when the app is
-- deployed with SUPABASE_JWT_SECRET set, so this file is safe to apply BEFORE
-- the app cutover. The SMS worker, SimpleTexting webhook, /l/[slug] redirect,
-- and all console/pg-meta paths stay service_role/supabase_admin forever.
--
-- APPLY AS supabase_admin (the real superuser here; `postgres` is NOT):
--   docker exec -i supabase-db psql -U supabase_admin -v ON_ERROR_STOP=1 -f <file>
--
-- ORDERING: apply AFTER 2026-08-06-console-sql.sql (and every earlier
-- marketinghub migration) — the deny-all surgery below ALTERs policies
-- 2026-08-05-engagement-suite.sql and its predecessors create, and the
-- service-only re-revokes touch the console tables 2026-08-06-console-sql.sql
-- creates. Fails loud (fail-closed) if any are missing.
--
-- TRANSACTIONAL: everything up to the pgrst notify is ONE transaction
-- (begin/commit — scope-pg-net precedent). Load-bearing for post-cutover
-- re-runs: the revoke-then-grant convergence below commits atomically, so
-- live `authenticated` traffic never sees a table between its REVOKE and its
-- GRANT, and an interrupted apply rolls back whole instead of stranding a
-- table revoked-but-not-granted.
--
-- RUNBOOK GOTCHA: role `authenticated` carries the image-default
-- statement_timeout of 8s (anon 3s) — the per-user path has a cap the
-- uncapped service_role path never had.
--
-- AFTER APPLY: this file ends with `select pg_notify('pgrst', 'reload schema');`
-- — PostgREST caches the schema and grants; do not strip it.

begin;

create schema if not exists marketinghub;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- console_impersonation_audit — one row per console impersonation run (the
-- /auth/impersonate surface): who minted a user-scoped token, the exact
-- claims, what was queried, and how it went. SERVICE-ONLY: rows are written
-- through getServiceClient() after execution; `authenticated` (the very role
-- being impersonated) must never read or write its own audit trail.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.console_impersonation_audit (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  actor_email   text not null,
  claims        jsonb not null,
  target_schema text not null,
  target_table  text not null,
  row_count     int,
  success       boolean not null,
  error         text
);

create index if not exists console_impersonation_audit_created_idx
  on marketinghub.console_impersonation_audit (created_at desc);

-- Defense-in-depth on top of the deny-all RLS below (console-sql precedent):
-- a forgotten policy fails CLOSED.
revoke all on marketinghub.console_impersonation_audit from anon, authenticated, public;

alter table marketinghub.console_impersonation_audit enable row level security;
alter table marketinghub.console_impersonation_audit force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'console_impersonation_audit'
      and policyname = 'console_impersonation_audit_deny_all'
  ) then
    create policy console_impersonation_audit_deny_all on marketinghub.console_impersonation_audit
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- DENY-ALL SURGERY — user tables ONLY. Every marketinghub table ships with a
-- RESTRICTIVE `<table>_deny_all` policy targeting anon + authenticated;
-- restrictive policies are AND-ed against permissive ones, so the matrix
-- policies below would still yield zero rows unless `authenticated` is
-- dropped from the restrictive set. ALTER POLICY ... TO anon re-scopes the
-- roles list (naturally idempotent — re-runs converge on the same list) and
-- RLS default-deny still blocks `authenticated` until a permissive policy
-- grants an op. Fails loud under ON_ERROR_STOP if a deny_all is missing
-- (deny-by-default invariant violated ⇒ stop, don't paper over).
--
-- Service-only tables (sms_webhook_events, console_snippets,
-- console_query_history, console_impersonation_audit) keep their
-- deny_all (anon, authenticated) UNTOUCHED.
-- ---------------------------------------------------------------------------
alter policy templates_deny_all               on marketinghub.templates               to anon;
alter policy contact_lists_deny_all           on marketinghub.contact_lists           to anon;
alter policy contact_list_members_deny_all    on marketinghub.contact_list_members    to anon;
alter policy sms_campaigns_deny_all           on marketinghub.sms_campaigns           to anon;
alter policy sms_campaign_recipients_deny_all on marketinghub.sms_campaign_recipients to anon;
alter policy sms_suppressions_deny_all        on marketinghub.sms_suppressions        to anon;
alter policy sms_suppression_audit_deny_all   on marketinghub.sms_suppression_audit   to anon;
alter policy sms_links_deny_all               on marketinghub.sms_links               to anon;
alter policy sms_link_clicks_deny_all         on marketinghub.sms_link_clicks         to anon;
alter policy sms_inbound_messages_deny_all    on marketinghub.sms_inbound_messages    to anon;

-- ---------------------------------------------------------------------------
-- POLICY MATRIX — permissive per-op policies for `authenticated`, named
-- `<table>_authenticated_<op>`. USING(true)/WITH CHECK(true): there is no row
-- ownership in this schema, so a permitted op is permitted on every row.
-- Ops NOT listed for a table stay denied (RLS default-deny + no grant).
--
--   templates                 SELECT, INSERT, UPDATE
--   contact_lists             SELECT, INSERT, UPDATE, DELETE
--   contact_list_members      SELECT, INSERT   (FK cascade delete bypasses RLS)
--   sms_campaigns             SELECT, INSERT, UPDATE
--   sms_campaign_recipients   SELECT, INSERT, UPDATE
--   sms_suppressions          SELECT, INSERT, DELETE
--   sms_suppression_audit     INSERT only
--   sms_links                 SELECT, INSERT
--   sms_link_clicks           SELECT only
--   sms_inbound_messages      SELECT, UPDATE
--   sms_webhook_events        NONE — service-only
--   console_*                 NONE — service-only
-- ---------------------------------------------------------------------------

-- templates: SELECT, INSERT, UPDATE
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'templates'
      and policyname = 'templates_authenticated_select'
  ) then
    create policy templates_authenticated_select on marketinghub.templates
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'templates'
      and policyname = 'templates_authenticated_insert'
  ) then
    create policy templates_authenticated_insert on marketinghub.templates
      for insert to authenticated with check (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'templates'
      and policyname = 'templates_authenticated_update'
  ) then
    create policy templates_authenticated_update on marketinghub.templates
      for update to authenticated using (true) with check (true);
  end if;
end $$;

-- contact_lists: SELECT, INSERT, UPDATE, DELETE
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'contact_lists'
      and policyname = 'contact_lists_authenticated_select'
  ) then
    create policy contact_lists_authenticated_select on marketinghub.contact_lists
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'contact_lists'
      and policyname = 'contact_lists_authenticated_insert'
  ) then
    create policy contact_lists_authenticated_insert on marketinghub.contact_lists
      for insert to authenticated with check (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'contact_lists'
      and policyname = 'contact_lists_authenticated_update'
  ) then
    create policy contact_lists_authenticated_update on marketinghub.contact_lists
      for update to authenticated using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'contact_lists'
      and policyname = 'contact_lists_authenticated_delete'
  ) then
    create policy contact_lists_authenticated_delete on marketinghub.contact_lists
      for delete to authenticated using (true);
  end if;
end $$;

-- contact_list_members: SELECT, INSERT (deletes ride the contact_lists FK
-- cascade, which bypasses RLS — no DELETE policy needed or wanted).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'contact_list_members'
      and policyname = 'contact_list_members_authenticated_select'
  ) then
    create policy contact_list_members_authenticated_select on marketinghub.contact_list_members
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'contact_list_members'
      and policyname = 'contact_list_members_authenticated_insert'
  ) then
    create policy contact_list_members_authenticated_insert on marketinghub.contact_list_members
      for insert to authenticated with check (true);
  end if;
end $$;

-- sms_campaigns: SELECT, INSERT, UPDATE
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_campaigns'
      and policyname = 'sms_campaigns_authenticated_select'
  ) then
    create policy sms_campaigns_authenticated_select on marketinghub.sms_campaigns
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_campaigns'
      and policyname = 'sms_campaigns_authenticated_insert'
  ) then
    create policy sms_campaigns_authenticated_insert on marketinghub.sms_campaigns
      for insert to authenticated with check (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_campaigns'
      and policyname = 'sms_campaigns_authenticated_update'
  ) then
    create policy sms_campaigns_authenticated_update on marketinghub.sms_campaigns
      for update to authenticated using (true) with check (true);
  end if;
end $$;

-- sms_campaign_recipients: SELECT, INSERT, UPDATE (claiming stays with the
-- worker via the service_role-only RPC — see the re-revoke below).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_campaign_recipients'
      and policyname = 'sms_campaign_recipients_authenticated_select'
  ) then
    create policy sms_campaign_recipients_authenticated_select on marketinghub.sms_campaign_recipients
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_campaign_recipients'
      and policyname = 'sms_campaign_recipients_authenticated_insert'
  ) then
    create policy sms_campaign_recipients_authenticated_insert on marketinghub.sms_campaign_recipients
      for insert to authenticated with check (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_campaign_recipients'
      and policyname = 'sms_campaign_recipients_authenticated_update'
  ) then
    create policy sms_campaign_recipients_authenticated_update on marketinghub.sms_campaign_recipients
      for update to authenticated using (true) with check (true);
  end if;
end $$;

-- sms_suppressions: SELECT, INSERT, DELETE (no UPDATE — suppression rows are
-- added and removed, never edited).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_suppressions'
      and policyname = 'sms_suppressions_authenticated_select'
  ) then
    create policy sms_suppressions_authenticated_select on marketinghub.sms_suppressions
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_suppressions'
      and policyname = 'sms_suppressions_authenticated_insert'
  ) then
    create policy sms_suppressions_authenticated_insert on marketinghub.sms_suppressions
      for insert to authenticated with check (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_suppressions'
      and policyname = 'sms_suppressions_authenticated_delete'
  ) then
    create policy sms_suppressions_authenticated_delete on marketinghub.sms_suppressions
      for delete to authenticated using (true);
  end if;
end $$;

-- sms_suppression_audit: INSERT only — an append-only TCPA evidence trail
-- the user path can write to but never read back or rewrite.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_suppression_audit'
      and policyname = 'sms_suppression_audit_authenticated_insert'
  ) then
    create policy sms_suppression_audit_authenticated_insert on marketinghub.sms_suppression_audit
      for insert to authenticated with check (true);
  end if;
end $$;

-- sms_links: SELECT, INSERT
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_links'
      and policyname = 'sms_links_authenticated_select'
  ) then
    create policy sms_links_authenticated_select on marketinghub.sms_links
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_links'
      and policyname = 'sms_links_authenticated_insert'
  ) then
    create policy sms_links_authenticated_insert on marketinghub.sms_links
      for insert to authenticated with check (true);
  end if;
end $$;

-- sms_link_clicks: SELECT only — clicks are recorded by the public /l/[slug]
-- redirect (service_role), the user path only reads the analytics.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_link_clicks'
      and policyname = 'sms_link_clicks_authenticated_select'
  ) then
    create policy sms_link_clicks_authenticated_select on marketinghub.sms_link_clicks
      for select to authenticated using (true);
  end if;
end $$;

-- sms_inbound_messages: SELECT, UPDATE (inbox handled-workflow; rows are
-- inserted by the webhook lane, service_role only).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_inbound_messages'
      and policyname = 'sms_inbound_messages_authenticated_select'
  ) then
    create policy sms_inbound_messages_authenticated_select on marketinghub.sms_inbound_messages
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub' and tablename = 'sms_inbound_messages'
      and policyname = 'sms_inbound_messages_authenticated_update'
  ) then
    create policy sms_inbound_messages_authenticated_update on marketinghub.sms_inbound_messages
      for update to authenticated using (true) with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- GRANTS — RLS only filters rows; without table privileges the policies above
-- are moot. The image's default privileges auto-grant to authenticated ONLY
-- in schema public — marketinghub gets nothing, so grant explicitly and
-- EXACTLY the matrix ops. Each table is revoke-then-grant so re-runs converge
-- on the exact matrix even if a broader grant ever sneaks in.
-- No sequence grants: every PK is uuid/gen_random_uuid(), no sequences exist.
-- NO default privileges for authenticated: future tables start service-only
-- and must opt in through a future migration (deny-by-default posture).
-- ---------------------------------------------------------------------------
grant usage on schema marketinghub to authenticated;

revoke all on marketinghub.templates from anon, authenticated, public;
grant select, insert, update on marketinghub.templates to authenticated;

revoke all on marketinghub.contact_lists from anon, authenticated, public;
grant select, insert, update, delete on marketinghub.contact_lists to authenticated;

revoke all on marketinghub.contact_list_members from anon, authenticated, public;
grant select, insert on marketinghub.contact_list_members to authenticated;

revoke all on marketinghub.sms_campaigns from anon, authenticated, public;
grant select, insert, update on marketinghub.sms_campaigns to authenticated;

revoke all on marketinghub.sms_campaign_recipients from anon, authenticated, public;
grant select, insert, update on marketinghub.sms_campaign_recipients to authenticated;

revoke all on marketinghub.sms_suppressions from anon, authenticated, public;
grant select, insert, delete on marketinghub.sms_suppressions to authenticated;

revoke all on marketinghub.sms_suppression_audit from anon, authenticated, public;
grant insert on marketinghub.sms_suppression_audit to authenticated;

revoke all on marketinghub.sms_links from anon, authenticated, public;
grant select, insert on marketinghub.sms_links to authenticated;

revoke all on marketinghub.sms_link_clicks from anon, authenticated, public;
grant select on marketinghub.sms_link_clicks to authenticated;

revoke all on marketinghub.sms_inbound_messages from anon, authenticated, public;
grant select, update on marketinghub.sms_inbound_messages to authenticated;

-- Views are security_invoker = true, so the base-table policies above enforce
-- through them — SELECT on the view itself is all `authenticated` needs.
revoke all on marketinghub.sms_campaign_recipient_counts from anon, authenticated, public;
grant select on marketinghub.sms_campaign_recipient_counts to authenticated;

revoke all on marketinghub.sms_campaign_engagement from anon, authenticated, public;
grant select on marketinghub.sms_campaign_engagement to authenticated;

-- Service-only tables: explicit re-revoke (defense-in-depth, console-sql
-- precedent — a forgotten policy fails CLOSED).
revoke all on marketinghub.sms_webhook_events from anon, authenticated, public;
revoke all on marketinghub.console_snippets from anon, authenticated, public;
revoke all on marketinghub.console_query_history from anon, authenticated, public;

-- claim_due_sms_recipients stays service_role-only (the worker's claim path).
-- Re-assert the load-bearing revoke from 2026-08-05 — `authenticated` must
-- never be able to claim outbox rows through PostgREST.
revoke execute on function marketinghub.claim_due_sms_recipients(int, int, int, int)
  from public, anon, authenticated;
grant execute on function marketinghub.claim_due_sms_recipients(int, int, int, int)
  to service_role;

-- Re-assert service_role privileges (idempotent, order-independent — same
-- block every marketinghub migration carries).
grant usage on schema marketinghub to service_role;
grant all privileges on all tables in schema marketinghub to service_role;
alter default privileges in schema marketinghub
  grant all privileges on tables to service_role;

-- ---------------------------------------------------------------------------
-- GoTrue CUSTOM ACCESS TOKEN HOOK — STUB, staged for the Wave-3 cutover.
-- The function is created now (inert: GoTrue only calls it when
-- GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED/_URI are set — those env lines are
-- staged COMMENTED in cdk/assets/render-env.sh, marked WAVE-3 CUTOVER, DO NOT
-- UNCOMMENT). Contract (GoTrue v2.186.0): jsonb event in — {"claims": {...}}
-- out; the stub returns the event untouched, so enabling it changes nothing
-- until real claim shaping lands. GoTrue invokes it over its
-- supabase_auth_admin connection with a 2s statement_timeout.
-- ---------------------------------------------------------------------------
create or replace function marketinghub.custom_access_token_hook(event jsonb)
returns jsonb
language sql
stable
as $$
  select event
$$;

-- EXECUTE goes to PUBLIC by default on new functions — revoke is load-bearing.
revoke execute on function marketinghub.custom_access_token_hook(jsonb)
  from public, anon, authenticated;
grant usage on schema marketinghub to supabase_auth_admin;
grant execute on function marketinghub.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

commit;

-- ---------------------------------------------------------------------------
-- PostgREST caches the schema AND role grants — reload or the new
-- `authenticated` surface 401/404s until restart. Deliberately OUTSIDE the
-- transaction (scope-pg-net precedent): NOTIFY only fires at commit anyway,
-- and a standalone statement signals the reload only after the commit above
-- has truly landed.
-- ---------------------------------------------------------------------------
select pg_notify('pgrst', 'reload schema');
