-- cdk/sql/rls-gate.sql
-- HIPAA RLS deploy gate (spec §12): returns ONE ROW PER OFFENDING TABLE per
-- arm. An exposed-schema table offends arm 1 if RLS is disabled OR it has
-- zero policies; an APP-schema table additionally offends arm 2 (below).
-- Zero rows returned = gate passes. Any rows = release BLOCKED
-- (deny-by-default).
--
-- Wave 4 (2026-08-08): marketinghub carries PERMISSIVE policies for
-- `authenticated`, so "has at least one policy" is no longer strong enough
-- for app schemas. An app-schema table additionally offends when:
--   * FORCE ROW LEVEL SECURITY is off (relforcerowsecurity = false — the
--     table owner would bypass RLS), or
--   * no RESTRICTIVE policy applying to `anon` exists (the `<table>_deny_all`
--     backstop; a policy TO public applies to anon too and also counts).
--
-- Wave 8 (2026-08-08) SCOPING FIX: live runs returned ~38 rows of
-- PRE-EXISTING bundle-internal posture — GoTrue's auth.* tables, the
-- storage-api service's internal tables, realtime's daily message
-- partitions + subscription ledger, the wrappers extension's stats table.
-- None of them are ours to fix (their owning bundle services manage them),
-- so they drowned the signal and made "ZERO rows" aspirational. They now
-- ride the DOCUMENTED allowlist below and ZERO rows is a real, enforceable
-- contract again. Allowlist rules:
--   * Bundle-managed INTERNALS ONLY. The app schemas (marketinghub,
--     competitor_intel) are NEVER allowlisted — belt and braces: no
--     allowlist row names them AND the gated CTE re-includes them
--     structurally, so a new app table without full posture still trips.
--   * storage.objects / storage.buckets are NEVER allowlisted either: they
--     are PostgREST-reachable (storage is in PGRST_DB_SCHEMAS) and hold OUR
--     object/bucket metadata. 2026-08-08-w8-competitor-intel.sql gives them
--     the deny-by-default backstop (RLS enabled + restrictive anon
--     deny_all; never FORCE — the storage-api owner keeps bypassing), so
--     they pass on posture, not by exemption. Until that migration applies,
--     these two are the only expected rows.
--   * realtime.messages (the parent) stays gated: Wave 5 gave it the
--     mh_recv/mh_send policies (asserted by cdk/test/w5-realtime.test.ts);
--     only its bundle-managed daily partitions are allowlisted (policies on
--     the parent do not appear in pg_policies for partitions).
--   * pgmq_public (PostgREST-exposed since Wave 8) holds functions only —
--     no tables to gate; the pgmq.q_*/pgmq.a_* backing tables live in the
--     unexposed pgmq schema. graphql_public is likewise function/view-only.
WITH exposed AS (
  SELECT t.schemaname, t.tablename, t.rowsecurity
  FROM pg_tables t
  -- marketinghub + competitor_intel are exposed to PostgREST via
  -- PGRST_DB_SCHEMAS (cdk/assets/docker-compose.override.yml), so
  -- PostgREST-reachable tables there must satisfy the deny-by-default gate;
  -- auth/realtime are gated as defense in depth even though PostgREST does
  -- not serve them.
  WHERE t.schemaname IN ('public', 'storage', 'auth', 'realtime', 'marketinghub', 'competitor_intel')
),
-- Bundle-managed internals (Wave 8 — see header). LIKE patterns with the
-- default backslash escape; `\_` is a literal underscore so a lookalike
-- name cannot ride an allowlist row.
bundle_allowlist(schemaname, tablename_like) AS (
  VALUES
    -- GoTrue owns and migrates every auth.* table (users, sessions, mfa_*,
    -- sso_*, saml_*, oauth_*, one_time_tokens, schema_migrations, ...).
    ('auth', '%'),
    -- storage-api service internals (its migration ledger + feature tables
    -- from the pinned v1.48.26 image). NEVER objects/buckets — those hold
    -- our data and are gated on real posture.
    ('storage', 'migrations'),
    ('storage', 'prefixes'),
    ('storage', 's3\_multipart\_uploads'),
    ('storage', 's3\_multipart\_uploads\_parts'),
    ('storage', 'buckets\_analytics'),
    ('storage', 'buckets\_vectors'),
    ('storage', 'vector\_indexes'),
    ('storage', 'iceberg\_%'),
    -- realtime tenant internals: daily partitions of realtime.messages (the
    -- PARENT stays gated), the postgres_changes subscription ledger, and
    -- the tenant migration ledger.
    ('realtime', 'messages\_%'),
    ('realtime', 'subscription'),
    ('realtime', 'schema\_migrations'),
    -- created by `create extension wrappers` (Wave 1); extension-managed.
    ('public', 'wrappers\_fdw\_stats')
),
app_schemas(schemaname) AS (
  VALUES ('marketinghub'), ('competitor_intel')
),
gated AS (
  SELECT e.schemaname, e.tablename, e.rowsecurity
  FROM exposed e
  -- App schemas are structurally exempt from the allowlist: even if someone
  -- later adds an allowlist row naming them (the cdk test forbids it), this
  -- OR keeps every app table gated.
  WHERE e.schemaname IN (SELECT a.schemaname FROM app_schemas a)
     OR NOT EXISTS (
          SELECT 1 FROM bundle_allowlist b
          WHERE b.schemaname = e.schemaname
            AND e.tablename LIKE b.tablename_like
        )
),
policy_counts AS (
  SELECT p.schemaname, p.tablename, COUNT(*) AS n_policies
  FROM pg_policies p
  GROUP BY p.schemaname, p.tablename
),
app_tables AS (
  SELECT n.nspname AS schemaname,
         c.relname AS tablename,
         c.relrowsecurity AS rowsecurity,
         c.relforcerowsecurity AS forcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN (SELECT a.schemaname FROM app_schemas a)
    -- 'r' (ordinary) AND 'p' (partitioned parent): pg_tables — arm 1's
    -- source — includes both, and FORCE RLS / restrictive policies are valid
    -- on partitioned parents in PG 15. Filtering to 'r' alone would let a
    -- future partitioned app table (an events/message ledger shape) pass
    -- arm 1 with a single permissive policy while arm 2 never evaluated its
    -- FORCE-RLS/anon-deny posture at all.
    AND c.relkind IN ('r', 'p')
),
app_restrictive_anon AS (
  SELECT p.schemaname, p.tablename, COUNT(*) AS n_restrictive_anon
  FROM pg_policies p
  WHERE p.schemaname IN (SELECT a.schemaname FROM app_schemas a)
    AND p.permissive = 'RESTRICTIVE'
    AND ('anon' = ANY (p.roles) OR 'public' = ANY (p.roles))
  GROUP BY p.schemaname, p.tablename
)
SELECT g.schemaname,
       g.tablename,
       g.rowsecurity,
       COALESCE(pc.n_policies, 0) AS n_policies,
       CASE
         WHEN g.rowsecurity = false THEN 'RLS_DISABLED'
         WHEN COALESCE(pc.n_policies, 0) = 0 THEN 'NO_POLICIES'
       END AS reason
FROM gated g
LEFT JOIN policy_counts pc
  ON pc.schemaname = g.schemaname AND pc.tablename = g.tablename
WHERE g.rowsecurity = false
   OR COALESCE(pc.n_policies, 0) = 0
UNION ALL
SELECT m.schemaname,
       m.tablename,
       m.rowsecurity,
       COALESCE(ra.n_restrictive_anon, 0) AS n_policies,
       CASE
         WHEN m.forcerowsecurity = false THEN 'RLS_NOT_FORCED'
         WHEN COALESCE(ra.n_restrictive_anon, 0) = 0 THEN 'NO_RESTRICTIVE_ANON_POLICY'
       END AS reason
FROM app_tables m
LEFT JOIN app_restrictive_anon ra
  ON ra.schemaname = m.schemaname AND ra.tablename = m.tablename
WHERE m.forcerowsecurity = false
   OR COALESCE(ra.n_restrictive_anon, 0) = 0
ORDER BY schemaname, tablename;
