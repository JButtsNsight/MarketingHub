# Supabase Parity — Wave 1: Database platform + console Database section

Part of the Supabase full-parity program (see `docs/reference/supabase-feature-catalog.md` for the 79-feature map). Directive: **"however Supabase does it is how we want to do it"** — enable features with Supabase's own components, manage them from our console the way Studio does, adopt in-app where natural.

## Live host facts (SSM recon 2026-08-07 — trust these over older docs)

- Postgres image is **supabase/postgres:15.8.1.085** (NOT PG17 — the design spec's PG17 claim is wrong on-box). `current_database()` = `postgres`.
- `shared_preload_libraries` = pg_stat_statements, pgaudit, plpgsql, plpgsql_check, **pg_cron**, **pg_net**, pgsodium, timescaledb, auto_explain, pg_tle, plan_filter, supabase_vault. `cron.database_name` = `postgres` (matches — no rename gotcha).
- Available-not-installed: **vector 0.8.0**, **pg_cron 1.6**, **pgmq 1.4.4**, **wrappers 0.4.6**, **pgaudit 1.7** (⚠️ `enable-pgaudit.sql` was evidently never applied — pgaudit is NOT in `pg_extension`), pgsodium 3.1.8, hypopg 1.4.1, index_advisor 0.2.0.
- Already installed: pg_graphql 1.5.11, pg_net 0.14.0 (extension present; our lockdown only revoked EXECUTE), pgjwt 0.2.0, supabase_vault 0.3.1, pg_stat_statements, pgcrypto, uuid-ossp.
- `PGRST_DB_SCHEMAS` = `public, storage, graphql_public, marketinghub` (live container env).
- Kong (kong/kong:3.9.1, config `/usr/local/kong/kong.yml`) already routes: `/rest/v1/`, `/graphql/v1` (key-auth), `/auth/v1/`, `/realtime/v1/`, `/storage/v1/`, `/functions/v1/`, open SAML routes `/sso/saml/acs|metadata`, `/.well-known/oauth-authorization-server`; `/pg/*` (postgres-meta) verified reachable 2026-08-06. Analytics route commented out in kong.yml, but **supabase-analytics (logflare 1.36.1) + supabase-vector (0.53.0) containers ARE running/healthy**.
- Other containers: gotrue v2.186.0, realtime v2.76.5, postgres-meta v0.96.3, storage-api v1.48.26 (ENABLE_IMAGE_TRANSFORMATION=true already), postgrest v14.8, studio 2026.04.27, supavisor 2.7.4, imgproxy v3.30.1. **supabase-edge-functions (edge-runtime v1.71.2) is restart-looping** (Wave-5 fix, not Wave 1).

## Scope

### A. Enablement (cdk/)

1. **`cdk/sql/2026-08-07-platform-extensions.sql`** (idempotent; applied AFTER engagement-suite per ordering rule; end with `pg_notify('pgrst','reload schema')`):
   - `create extension if not exists vector` / `pg_cron` / `pgmq` / `wrappers` / `hypopg` / `index_advisor`.
   - pgaudit: `create extension if not exists pgaudit` + the settings from `cdk/sql/enable-pgaudit.sql` (fold in; that file's "applied" status was false).
   - pgmq exposure per official self-hosted guide: create `pgmq_public` wrapper schema with SECURITY DEFINER wrappers (`send`, `send_batch`, `read`, `pop`, `archive`, `delete`) delegating to `pgmq.*`; grants to service_role only (no anon/authenticated — no browser clients yet).
   - Grants: cron schema usage to service_role (console reads `cron.job`/`cron.job_run_details`); revoke by default elsewhere.
2. **`cdk/sql/scope-pg-net.sql`** — REPLACES `lockdown-pg-net.sql` (delete it): pg_net stays installed; EXECUTE on `net.http_*` revoked from PUBLIC/anon/authenticated, granted to a new `webhooks_admin` NOLOGIN role (+ service_role for the console/webhooks surface); `pgaudit.log` set for that role. Comment explains the approved posture change (2026-08-07).
3. **Host env**: `cdk/assets/render-env.sh` + `docker-compose.override.yml` — append `pgmq_public` to `PGRST_DB_SCHEMAS`. Live apply procedure (SSM: regenerate env → `docker compose up -d rest` or restart rest container) documented in **new runbook section** `docs/runbooks/supabase-host-apply.md` (repo-first drift discipline; re-runnable).
4. **cdk tests**: extend the sql test pattern (see `cdk/test/` console-sql/engagement-sql tests) for the new migration: idempotency (double-apply), extension list assertions, pgmq_public grants, scope-pg-net grants.

### B. Console foundation (web/src/lib/console/)

5. **`pgmeta.ts` extension** (single owner — one agent): typed methods for `/pg/functions`, `/pg/triggers`, `/pg/types`, `/pg/publications`, `/pg/roles`, `/pg/policies` (CRUD — POST/PATCH/DELETE, not just list), `/pg/extensions` (POST enable / DELETE disable), `/pg/indexes` (via `/query` if no endpoint at postgres-meta v0.96.3 — check its README for exact routes; prefer native endpoints, fall back to typed `/query` SQL).
6. **New libs**: `advisors.ts` (vendored splinter SQL — fetch `supabase/splinter` lint queries into `web/src/lib/console/splinter/*.sql` as string modules or a generated TS file, with license header; runner executes via pg-meta `/query` read-only tx), `cron.ts` (job list/schedule/unschedule/run-details via `/query` on `cron.*`), `queues.ts` (pgmq list/metrics/peek/send/archive/purge via `/query` on `pgmq.*`), `webhooks.ts` (trigger-based webhooks à la Studio: `supabase_functions.http_request` triggers using pg_net; list/create/delete).
7. Dependencies (single owner adds ALL new deps in one commit): `reactflow` (schema designer). No other new runtime deps expected — Uppy etc. is Wave 2.

### C. Console surfaces (web/src/app/(app)/… + /api/console/…)

Follow existing patterns exactly: pages mirror `database/page.tsx` + `PageHeader` + console tokens (light = NSight, dark = Supabase look); API routes mirror `api/console/rows/route.ts` (requireUser(headers, "marketing"), zod validation, introspection-validated identifiers); destructive ops behind `useConfirm` AlertDialog (guard the write, not the browse); SQL identifiers always via the existing quoting helpers.

Nav (Studio IA parity): Platform group's **Database** item becomes a subtree (match Studio's Database section list): Schema (existing), Policies (upgraded), Functions, Triggers, Indexes, Types