# Declarative schemas — repo convention (Wave 8 onward)

This directory holds **declared end-state DDL** for schemas built with the
Supabase declarative-schema workflow. It starts empty on purpose: the first
(and so far only) planned occupant is `competitor_intel.sql` for the Wave-8
competitor-intel module. **No retrofit** — the existing `marketinghub` schema
(and everything else already live) stays on the hand-written, dated
`cdk/sql/` migration chain and is never re-declared here.

## The one-paragraph rule

Declare a NEW schema's end state in `supabase/schemas/<schema>.sql`, use
`supabase db diff` against a local shadow database to generate the DDL
skeleton, then hand-finish a dated, idempotent `cdk/sql/` migration. **The
committed `cdk/sql/` migration remains the applied artifact** — we deploy via
our own tooling (`docker exec supabase-db psql` as `supabase_admin`, single
transaction, `pg_notify('pgrst','reload schema')` as the sole post-commit
statement, per the w4/w5/w7 precedent), never via `supabase db push`.

## Workflow (W8 `competitor_intel`)

1. **Declare** the end state in `supabase/schemas/competitor_intel.sql` —
   tables, indexes, functions, views for the new schema. This file is the
   reviewed source of truth for *shape*; review it like code.
2. **Diff** to generate the migration skeleton:

   ```sh
   # Shadow DB = a throwaway pinned container, NOT the CLI's default stack
   # (the CLI's `supabase start` images track the CLI release, not our prod
   # pin — fine for iteration, not evidence of behavior at our pin):
   docker run -d --name w8-shadow -p 54329:5432 \
     -e POSTGRES_PASSWORD=postgres supabase/postgres:15.8.1.085
   # apply the existing dated cdk/sql chain to the shadow first, then:
   npx supabase@2.113.0 db diff -f competitor_intel \
     --db-url postgresql://postgres:postgres@127.0.0.1:54329/postgres
   docker rm -f w8-shadow
   ```

3. **Hand-finish** the output into
   `cdk/sql/<date>-w8-competitor-intel.sql`: idempotency guards
   (`if not exists`, `pg_policies` checks), single transaction, header
   ("APPLY AS supabase_admin", ordering line, PG 15.8, "safe to re-run"),
   and everything the diff engine cannot produce (next section).
4. **Test** with a `cdk/test/` string-assertion jest file cloned from the
   `w5-realtime.test.ts` / `w7-backups-vault.test.ts` pattern.

## What the diff does NOT capture (hand-write these in the migration)

Per the official docs, `supabase db diff` skips:

- **DML** (seed/data changes)
- **RLS policies** (alterations) and **column privileges**
- **grants / schema privileges / default-privilege grants**
- **comments**
- view **ownership** and `security_invoker` settings
- **materialized views**
- **partitions**
- **publications**
- **domains**

For this repo that means the security-relevant majority of every migration —
RLS policies, the grant matrix, the RESTRICTIVE `anon` deny-all backstop
(`rls-gate.sh` compliance) — is always hand-written in the `cdk/sql/` file
and asserted by its cdk test. Treat the diff output as a DDL skeleton only,
and review every generated migration before committing.

## Other conventions

- **One file per schema** (`competitor_intel.sql`), not per table. Ordering,
  if more files ever appear, is lexicographic unless
  `supabase/config.toml` `[db.migrations] schema_paths` says otherwise.
- **The diff never sees the live database.** It compares schema files against
  migration history via a shadow DB, so anything applied out-of-band (in-app
  SQL editor, pg-meta `POST /query`) is invisible to it. For declared
  schemas, route all DDL through this workflow.
- **Docker required** for both the shadow container and the CLI's internal
  postgres-meta introspection container.
- Docs: <https://supabase.com/docs/guides/local-development/declarative-database-schemas>

## Why not adopt this for `marketinghub` too?

Retrofit would require dumping the live schema into a declared file and
keeping it perfectly in sync with a migration chain that predates the
convention — high drift risk for zero behavior change, and our applied
artifact would still be the `cdk/sql` chain. New schemas only.
