-- cdk/sql/enable-rls-template.sql
-- Template for locking down a PHI-bearing table BEFORE any PHI is loaded (spec §12).
-- Replace <schema>.<table> and the policy predicates. FORCE also applies RLS to the
-- table owner so a migration role cannot accidentally bypass it.

ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <schema>.<table> FORCE ROW LEVEL SECURITY;

-- Deny-by-default: with RLS enabled and NO permissive policy, all access is denied.
-- This explicit deny policy makes the intent unmistakable and survives a later
-- accidental "grant everyone" policy being added to the same command set.
CREATE POLICY deny_all_default ON <schema>.<table>
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Explicit per-subject access example (owner-scoped). Add real policies like this;
-- absence of a permissive policy = no rows returned = fail closed.
CREATE POLICY owner_can_select ON <schema>.<table>
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Strip default privileges so a forgotten policy fails CLOSED, then grant explicitly.
REVOKE ALL ON <schema>.<table> FROM anon, authenticated, PUBLIC;
GRANT SELECT ON <schema>.<table> TO authenticated;
