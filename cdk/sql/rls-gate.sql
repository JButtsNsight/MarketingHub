-- cdk/sql/rls-gate.sql
-- HIPAA RLS deploy gate (spec §12): returns ONE ROW PER OFFENDING TABLE.
-- An exposed-schema table is offending if RLS is disabled OR it has zero policies.
-- Zero rows returned = gate passes. Any rows = release BLOCKED (deny-by-default).
--
-- Wave 4 (2026-08-08): marketinghub now carries PERMISSIVE policies for
-- `authenticated`, so "has at least one policy" is no longer strong enough
-- there. A marketinghub table additionally offends when:
--   * FORCE ROW LEVEL SECURITY is off (relforcerowsecurity = false — the
--     table owner would bypass RLS), or
--   * no RESTRICTIVE policy applying to `anon` exists (the `<table>_deny_all`
--     backstop; a policy TO public applies to anon too and also counts).
WITH exposed AS (
  SELECT t.schemaname, t.tablename, t.rowsecurity
  FROM pg_tables t
  -- `marketinghub` is exposed to PostgREST via PGRST_DB_SCHEMAS
  -- (cdk/assets/docker-compose.override.yml), so a PostgREST-reachable table
  -- there must also satisfy the deny-by-default gate — include it here.
  WHERE t.schemaname IN ('public', 'storage', 'auth', 'realtime', 'marketinghub')
),
policy_counts AS (
  SELECT p.schemaname, p.tablename, COUNT(*) AS n_policies
  FROM pg_policies p
  GROUP BY p.schemaname, p.tablename
),
mh_tables AS (
  SELECT n.nspname AS schemaname,
         c.relname AS tablename,
         c.relrowsecurity AS rowsecurity,
         c.relforcerowsecurity AS forcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'marketinghub'
    AND c.relkind = 'r'
),
mh_restrictive_anon AS (
  SELECT p.schemaname, p.tablename, COUNT(*) AS n_restrictive_anon
  FROM pg_policies p
  WHERE p.schemaname = 'marketinghub'
    AND p.permissive = 'RESTRICTIVE'
    AND ('anon' = ANY (p.roles) OR 'public' = ANY (p.roles))
  GROUP BY p.schemaname, p.tablename
)
SELECT e.schemaname,
       e.tablename,
       e.rowsecurity,
       COALESCE(pc.n_policies, 0) AS n_policies,
       CASE
         WHEN e.rowsecurity = false THEN 'RLS_DISABLED'
         WHEN COALESCE(pc.n_policies, 0) = 0 THEN 'NO_POLICIES'
       END AS reason
FROM exposed e
LEFT JOIN policy_counts pc
  ON pc.schemaname = e.schemaname AND pc.tablename = e.tablename
WHERE e.rowsecurity = false
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
FROM mh_tables m
LEFT JOIN mh_restrictive_anon ra
  ON ra.schemaname = m.schemaname AND ra.tablename = m.tablename
WHERE m.forcerowsecurity = false
   OR COALESCE(ra.n_restrictive_anon, 0) = 0
ORDER BY schemaname, tablename;
