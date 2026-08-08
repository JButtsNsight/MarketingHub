-- cdk/sql/2026-08-07-scope-pg-net.sql
--
-- Apply as: supabase_admin (SUPERUSER).
-- Supersedes: cdk/sql/lockdown-pg-net.sql.
--
-- WHAT / WHY
-- lockdown-pg-net.sql took a blanket posture: pg_net EXECUTE revoked from
-- PUBLIC/anon/authenticated, with NO role able to invoke it from SQL. That was
-- correct while nothing needed outbound HTTP. Database Webhooks
-- (web/src/lib/console/webhooks.ts) change that: a webhook is a trigger that
-- dispatches through supabase_functions.http_request -> net.http_post/get. So
-- we REPLACE the blanket posture with a SCOPED one:
--
--   * a dedicated NOLOGIN role `webhooks_admin` owns the pg_net capability;
--   * EXECUTE on net.http_post/http_get/http_delete is granted ONLY to
--     `webhooks_admin` only (the SECURITY DEFINER http_request fn runs as its owner, so service_role does not need net EXECUTE);
--   * anon / authenticated / PUBLIC remain fully revoked (incl. future funcs);
--   * every call to net.* is audited via pgaudit object-level auditing.
--
-- Net effect: outbound HTTP from inside Postgres stays impossible for untrusted
-- roles, becomes possible only for the two trusted identities, and is logged.
-- This file is IDEMPOTENT — safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Dedicated capability role (NOLOGIN — it is a privilege holder, not a login)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'webhooks_admin') THEN
    CREATE ROLE webhooks_admin NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Re-assert the deny-by-default posture (idempotent; keeps the lockdown's
--    guarantees intact before we open the two scoped holes below).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION net.http_get(text, jsonb, jsonb, integer)         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION net.http_delete(text, jsonb, jsonb, integer)      FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Scoped grant: only webhooks_admin may call net.*
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA net TO webhooks_admin;

GRANT EXECUTE ON FUNCTION net.http_get(text, jsonb, jsonb, integer)         TO webhooks_admin;
GRANT EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) TO webhooks_admin;
GRANT EXECUTE ON FUNCTION net.http_delete(text, jsonb, jsonb, integer)      TO webhooks_admin;

-- Future functions added to the net schema default to webhooks_admin.
ALTER DEFAULT PRIVILEGES IN SCHEMA net GRANT EXECUTE ON FUNCTIONS TO webhooks_admin;

-- ---------------------------------------------------------------------------
-- 4. pgaudit object-level auditing of net.*
--
-- pgaudit logs any statement touching an object for which its designated audit
-- role holds the matching privilege. We create a NOLOGIN `pgaudit` audit role,
-- point pgaudit.role at it, and grant it EXECUTE on net.* — no one is a member
-- of `pgaudit`, so this grants zero real capability; it only marks net.* as
-- audited, so every net call is written to the audit log with the AUDIT tag.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pgaudit') THEN
    CREATE ROLE pgaudit NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA net TO pgaudit;
GRANT EXECUTE ON FUNCTION net.http_get(text, jsonb, jsonb, integer)         TO pgaudit;
GRANT EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) TO pgaudit;
GRANT EXECUTE ON FUNCTION net.http_delete(text, jsonb, jsonb, integer)      TO pgaudit;

-- Point pgaudit's object-audit at the `pgaudit` role for this database. (GUC is
-- superuser-only; ALTER DATABASE persists it without an ALTER SYSTEM reload.)
ALTER DATABASE postgres SET pgaudit.role = 'pgaudit';

COMMIT;

-- POST-APPLY (run once, outside this transaction, so existing sessions pick up
-- the pgaudit.role GUC):
--   SELECT pg_reload_conf();
-- New connections read it automatically; the ALTER DATABASE above is durable.
