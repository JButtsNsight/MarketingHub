-- cdk/sql/2026-08-07-parity-platform-extensions.sql
-- Supabase parity — Wave 1, part A: enable the platform extensions Supabase
-- ships so we run them the same way Supabase does. Additive + idempotent.
--
-- ORDERING: apply AFTER 2026-08-05-engagement-suite.sql (engagement recreates
-- the claim RPC). This migration only CREATEs extensions/schema/functions and
-- never touches marketinghub tables, so it is order-independent w.r.t. the
-- other app migrations, but keep it last by date per the repo convention.
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');`.
--
-- Recon (2026-08-07, live host i-06a9f48d434cbebc7): image
-- supabase/postgres:15.8.1.085; shared_preload_libraries already contains
-- pg_cron, pg_net, pgaudit, supabase_vault; cron.database_name = 'postgres' =
-- current_database(), so pg_cron installs into the right DB with no gotcha.
-- vector 0.8.0 (HNSW + iterative scans), pg_cron 1.6, pgmq 1.4.4, wrappers
-- 0.4.6, pgaudit 1.7 are all available-but-not-installed.

-- pgvector: embedding storage + similarity search (competitor-intel RAG, Wave 8).
-- 0.8.0 supports HNSW and iterative index scans.
create extension if not exists vector;

-- pg_cron: in-database job scheduler (Advisors sweeps, pgmq archive, Wave-8
-- embedding refresh). Superuser-only; installs into cron.database_name.
create extension if not exists pg_cron;

-- wrappers: Foreign Data Wrapper substrate. No FDW servers are created here —
-- those are provisioned per use so no external egress is opened by enabling it.
create extension if not exists wrappers;

-- pgmq: durable message queue (visibility-timeout reads = the same
-- FOR UPDATE SKIP LOCKED pattern we hand-rolled for the SMS outbox). Used first
-- as the embedding-job queue in Wave 8, not as an SMS-outbox migration.
create extension if not exists pgmq;

-- pgaudit: HIPAA §164.312(b) audit controls. RECON FINDING: pgaudit was in
-- shared_preload_libraries but NEVER installed (enable-pgaudit.sql was not in
-- effect on this DB). Install it and re-assert the config from that file so the
-- control is actually live. Kept consistent with cdk/sql/enable-pgaudit.sql.
create extension if not exists pgaudit;
alter system set pgaudit.log = 'ddl, role';
alter system set pgaudit.log_catalog = off;
alter system set pgaudit.log_parameter = off;   -- never log parameters (no PHI in logs)
alter system set pgaudit.log_relation = on;
select pg_reload_conf();
alter role authenticated set pgaudit.log = 'read, write';
alter role service_role  set pgaudit.log = 'read, write';
alter role anon          set pgaudit.log = 'read, write';

-- ---------------------------------------------------------------------------
-- pgmq_public: the wrapper schema Supabase uses to expose queues over the Data
-- API, mirrored verbatim from the official "Expose Queues to client-side
-- libraries" / self-hosting guide. SECURITY DEFINER so callers need rights on
-- pgmq_public.* only, not on pgmq internals. service_role is the only grantee
-- for now (server-only app); per-user roles are added in Wave 4. Queue rows are
-- reachable through our console via pg-meta POST /query without PostgREST
-- exposure; adding pgmq_public to PGRST_DB_SCHEMAS is deferred to the Queues
-- page (needs a rest-container reconfigure).
-- ---------------------------------------------------------------------------
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
  select * from pgmq.send(
    queue_name := queue_name,
    msg        := message,
    delay      := sleep_seconds
  );
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
  select * from pgmq.send_batch(
    queue_name := queue_name,
    msgs       := messages,
    delay      := sleep_seconds
  );
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
  select * from pgmq.read(
    queue_name := queue_name,
    vt         := sleep_seconds,
    qty        := n
  );
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

-- Verify (acceptance):
--   select extname, extversion from pg_extension
--     where extname in ('vector','pg_cron','pgmq','wrappers','pgaudit') order by 1;
--   select pgmq_public.send('parity_smoke', '{"hello":"world"}'::jsonb);
--   select msg_id, message from pgmq_public.read('parity_smoke', 5, 1);
