-- cdk/sql/rls-gate.sql
-- HIPAA RLS deploy gate (spec §12): returns ONE ROW PER OFFENDING TABLE.
-- An exposed-schema table is offending if RLS is disabled OR it has zero policies.
-- Zero rows returned = gate passes. Any rows = release BLOCKED (deny-by-default).
WITH exposed AS (
  SELECT t.schemaname, t.tablename, t.rowsecurity
  FROM pg_tables t
  WHERE t.schemaname IN ('public', 'storage', 'auth', 'realtime')
),
policy_counts AS (
  SELECT p.schemaname, p.tablename, COUNT(*) AS n_policies
  FROM pg_policies p
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
ORDER BY e.schemaname, e.tablename;
