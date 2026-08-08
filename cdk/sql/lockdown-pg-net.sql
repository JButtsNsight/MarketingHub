-- cdk/sql/lockdown-pg-net.sql
--
-- SUPERSEDED by cdk/sql/2026-08-07-scope-pg-net.sql (2026-08-07).
-- Kept in tree for history / rollback reference only. The blanket revoke below
-- left NO role able to call pg_net; once Database Webhooks needed outbound HTTP,
-- the scoping migration REPLACED this posture with a scoped grant
-- (net.* EXECUTE -> webhooks_admin + service_role only, still revoked from
-- anon/authenticated/PUBLIC, plus pgaudit coverage). Apply that file, not this
-- one, on a fresh environment.
--
-- pg_net SSRF/exfil lockdown (spec §12). pg_net lets code inside Postgres make outbound
-- HTTP calls; untrusted roles must NOT be able to invoke it. If pg_net is unused in v1,
-- prefer DROP EXTENSION (uncomment below); otherwise revoke EXECUTE broadly.

-- Revoke the ability to run pg_net from every untrusted / public role.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;

-- Belt-and-suspenders for the specific worker functions (in case new functions are added
-- to the schema and the blanket revoke above is re-granted by an extension upgrade).
REVOKE EXECUTE ON FUNCTION net.http_get(text, jsonb, jsonb, integer)            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION net.http_delete(text, jsonb, jsonb, integer)         FROM PUBLIC, anon, authenticated;

-- Default privileges for FUTURE functions created in the net schema: no EXECUTE to untrusted roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- If pg_net is unused in v1 (spec §12 preference), disable it entirely instead:
-- DROP EXTENSION IF EXISTS pg_net CASCADE;
