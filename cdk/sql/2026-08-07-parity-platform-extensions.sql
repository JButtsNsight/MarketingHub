-- cdk/sql/2026-08-07-parity-platform-extensions.sql
-- Supabase parity — Wave 1, part A: enable the platform extensions Supabase
-- ships so we run them the same way Supabase does. Additive + idempotent.
--
-- APPLY AS supabase_admin (the real superuser in this deployment). RECON
-- FINDING 2026-08-07: the `postgres` role here is NOT a superuser — ALTER
-- SYSTEM / ALTER ROLE ... SET are denied to it ("permission denied to set
-- parameter"), which is why the pre-existing enable-pgaudit.sql never took
-- effect. pg-meta/Studio connect as supabase_admin; do the same:
--   docker exec -i supabase-db psql -U supabase_admin -v ON_ERROR_STOP=1 -f <file>
--
-- ORDERING: apply AFTER 2026-08-05-engagement-suite.sql. This migration only
-- CREATEs extensions/schema/functions/config and never touches marketinghub
-- tables. AFTER APPLY: `select pg_notify('pgrst', 'reload schema');`.
--
-- Host image supabase/postgres:15.8.1.085; shared_preload_libraries already
-- has pg_cron, pg_net, pgaudit, supabase_vault; cron.database_name = 'postgres'
-- = current_database(), so pg_cron installs into the right DB. vector 0.8.0
-- (HNSW + iterative scans), pg_cron 1.6, pgmq 1.4.4, wrappers 0.4.6,
-- pgaudit 1.7 are all available.

-- === Extensions =============================================================

-- pgvector: embedding storage + similarity search (competitor-intel RAG, Wave 8).
create extension if not exists vector;

-- pg_cron: in-database job scheduler (Advisors sweeps, pgmq archive, Wave-8
-- embedding refresh). Installs into cron.database_name (= postgres here).
create extension if not exists pg_cron;

-- wrappers: Foreign Data Wrapper substrate. No FDW servers created here — those
-- are provisioned per use, so enabling it opens no external egress.
create extension if not exists wrappers;

-- pgmq: durable message queue (visibility-timeout reads = the same
-- FOR UPDATE SKIP LOCKED pattern we hand-rolled for the SMS outbox). Used first
-- as the embedding-job queue in Wave 8, not as an SMS-outbox migration.
create extension if not exists pgmq;

-- pgaudit: HIPAA §164.312(b) audit controls. Was preloaded but never installed.
create extension if not exists pgaudit;

-- === pgmq_public wrappers ===================================================
-- The schema Supabase uses to expose queues over the Data API, mirrored from
-- the official "Expose Queues to client-side libraries" / self-hosting guide.
-- Placed BEFORE the superuser-only pgaudit GUC config so the queue surface is
-- created even if the audit-config step is ever skipped. SECURITY DEFINER so
-- callers need rights on pgmq_public.* only. service_role is the sole grantee
-- for now (server-only app); per-user roles are added in Wave 4.

create schema if not exists pgmq_public;
grant usage on schema pgmq_public to service_role;

create or replace function pgmq_public.send(
  queue_name text,
  message jsonb,
  sleep_seconds integer default 0
)
returns setof bigint
language plpgsql
set search_path = ''
security definer
as $$
begin
  return query
  select * from pgmq.send(queue_name := queue_name, msg := message, delay := sleep_seconds);
end;
$$;
comment on function pgmq_public.send is 'Send a message to a queue (delay in seconds).';

create or replace function pgmq_public.send_batch(
  queue_name text,
  messages jsonb[],
  sleep_seconds integer default 0
)
returns setof bigint
language plpgsql
set search_path = ''
security definer
as $$
begin
  return query
  select * from pgmq.send_batch(queue_name := queue_name, msgs := messages, delay := sleep_seconds);
end;
$$;
comment on function pgmq_public.send_batch is 'Send a batch of messages to a queue (delay in seconds).';

create or replace function pgmq_public.read(
  queue_name text,
  sleep_seconds integer,
  n integer
)
returns setof pgmq.message_record
language plpgsql
set search_path = ''
security definer
as $$
begin
  return query
  select * from pgmq.read(queue_name := queue_name, vt := sleep_seconds, qty := n);
end;
$$;
comment on function pgmq_public.read is 'Read up to n messages, hiding them for sleep_seconds (visibility timeout).';

create or replace function pgmq_public.pop(queue_name text)
returns setof pgmq.message_record
language plpgsql
set search_path = ''
security definer
as $$
begin
  return query
  select * from pgmq.pop(queue_name := queue_name);
end;
$$;
comment on function pgmq_public.pop is 'Read and delete a single message from a queue.';

create or replace function pgmq_public.archive(queue_name text, message_id bigint)
returns boolean
language plpgsql
set search_path = ''
security definer
as $$
begin
  return pgmq.archive(queue_name := queue_name, msg_id := message_id);
end;
$$;
comment on function pgmq_public.archive is 'Move a message from the queue to its archive table.';

create or replace function pgmq_public.delete(queue_name text, message_id bigint)
returns boolean
language plpgsql
set search_path = ''
security definer
as $$
begin
  return pgmq.delete(queue_name := queue_name, msg_id := message_id);
end;
$$;
comment on function pgmq_public.delete is 'Permanently delete a message from a queue.';

grant execute on all functions in schema pgmq_public to service_role;
alter default privileges in schema pgmq_public grant execute on functions to service_role;

-- === pgaudit config (SUPERUSER ONLY — supabase_admin) =======================
-- Consistent with cdk/sql/enable-pgaudit.sql. These ALTER SYSTEM / ALTER ROLE
-- statements require the real superuser; running the migration as `postgres`
-- fails here with "permission denied to set parameter".
alter system set pgaudit.log = 'ddl, role';
alter system set pgaudit.log_catalog = off;
alter system set pgaudit.log_parameter = off;   -- never log parameters (no PHI in logs)
alter system set pgaudit.log_relation = on;
select pg_reload_conf();
alter role authenticated set pgaudit.log = 'read, write';
alter role service_role  set pgaudit.log = 'read, write';
alter role anon          set pgaudit.log = 'read, write';

-- Verify (acceptance):
--   select extname, extversion from pg_extension
--     where extname in ('vector','pg_cron','pgmq','wrappers','pgaudit') order by 1;
--   select pgmq_public.send('parity_smoke', '{"hello":"world"}'::jsonb);
--   select msg_id, message from pgmq_public.read('parity_smoke', 5, 1);
