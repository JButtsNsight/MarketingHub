# Supabase Parity — Wave 1: Database platform + console Database section

_Part of the full-parity program (`~/.claude/plans/floofy-drifting-snowflake.md`). This is the first, foundation wave: no posture risk, the biggest visible parity jump, and the substrate the competitor-intel RAG module (Wave 8) needs._

## Goal

Bring the **Database** and **Studio Database-section** feature groups to parity: enable the Postgres platform extensions Supabase ships (vector, pg_cron, pgmq, wrappers, pgaudit) and build the in-app console surfaces that manage them the way Studio does — all on the existing pg-meta client, Cognito-gated, with the write-guard patterns already in the console.

## Live recon (2026-08-07, via SSM on i-06a9f48d434cbebc7) — authoritative, corrects the catalog

Container / DB facts as they actually are, not as the spec/memory claim:

- **Postgres is `supabase/postgres:15.8.1.085` — NOT PG17.** The design spec (§22) and memory say PG17; the running image is 15.x. Flagged as drift (see Risks). All Wave-1 targets are available on this image, so Wave 1 is unblocked, but the discrepancy must be reconciled.
- `shared_preload_libraries` already includes `pg_cron, pg_net, pgaudit, pgsodium, supabase_vault, pg_stat_statements, pg_tle, plan_filter, timescaledb, auto_explain` — so no preload/restart is needed to enable pg_cron.
- `cron.database_name = postgres` and `current_database() = postgres` → the non-`postgres`-DB pg_cron gotcha does **not** apply to us.
- Extension availability / install state (`pg_available_extensions`):
  - **Available, NOT installed** (Wave-1 targets): `vector 0.8.0` (HNSW + iterative index scans both supported), `pg_cron 1.6`, `pgmq 1.4.4`, `wrappers 0.4.6`, `pgaudit 1.7`, `pgsodium 3.1.8`, `hypopg 1.4.1`, `index_advisor 0.2.0`.
  - **Already installed**: `pg_graphql 1.5.11`, `pg_net 0.14.0`, `supabase_vault 0.3.1`, `pgcrypto 1.3`, `pgjwt 0.2.0`, `pg_stat_statements 1.10`, `uuid-ossp 1.1`, `plpgsql`.
  - **Catalog correction**: `pgaudit` is preloaded but **not installed** — the repo's `cdk/sql/enable-pgaudit.sql` was evidently never applied to this DB (or the DB was rebuilt after). The catalog/memory claim "extensions enabled by our SQL: pgcrypto, pgaudit" is wrong for pgaudit.
- `PGRST_DB_SCHEMAS = "public, storage, graphql_public, marketinghub"`; `PGRST_DB_ANON_ROLE = anon`; an `anon` role + `ANON_KEY` exist (browser-client path is present infra-wise, relevant to later waves).
- Kong (`/usr/local/kong/kong.yml`, key-gated consumers anon/service_role): routes present for `/rest/v1`, **`/graphql/v1`**, `/realtime/v1`, `/storage/v1`, `/functions/v1`, `/auth/v1`, **`/sso/saml/acs` + `/sso/saml/metadata`** (SAML plumbing already at the gateway), `.well-known/oauth-authorization-server`. The **`analytics-v1-api` route is commented out** even though the analytics container runs (Wave-6 nuance: Studio Logs is inert because Kong doesn't route to Logflare, not because Logflare is down).
- **`supabase-analytics` (logflare 1.36.1) and `supabase-vector` (timberio/vector 0.53.0) are RUNNING and healthy** — the catalog's "analytics never enabled" is wrong; Wave 6 shrinks to Kong-route + console surfaces.
- **`supabase-edge-functions` (edge-runtime v1.71.2) is actively `Restarting`** — a live incident, deferred to Wave 5 but noted now.
- Other versions: kong 3.9.1, gotrue v2.186.0 (recent enough for SAML), realtime v2.76.5, storage-api v1.48.26, postgres-meta v0.96.3, supavisor 2.7.4, postgrest v14.8, studio 2026.04.27, imgproxy v3.30.1 (`ENABLE_IMAGE_TRANSFORMATION=true`, `IMGPROXY_URL=http://imgproxy:5001` → Wave-2 transforms are already switched on server-side).

## Scope

### A. Enablement — SQL migrations (`cdk/sql/`, idempotent, applied AFTER engagement-suite per ordering rule)

New migration `cdk/sql/2026-08-07-parity-platform-extensions.sql`:
- `create extension if not exists vector;` — into a dedicated `extensions`-style location per Supabase convention (verify where existing extensions live; match it).
- `create extension if not exists pg_cron;` (superuser; DB is `postgres` so it lands correctly).
- `create extension if not exists pgmq;` then create the `pgmq_public` wrapper schema + SECURITY DEFINER wrappers per the official "Expose Queues for local and self-hosted Supabase" guide (`send`, `read`, `pop`, `archive`, `delete`, `list_queues`), granting execute to `service_role` (and later per-user roles in Wave 4). No PostgREST exposure is strictly required since the app is server-side, but exposing `pgmq_public` matches Studio's Queues UI and keeps parity.
- `create extension if not exists wrappers;` (FDW substrate; no FDW servers created yet — those are per-use).
- **pgaudit fix**: `create extension if not exists pgaudit;` and re-assert the `pgaudit.log`/per-role settings from `enable-pgaudit.sql` (reconcile the two files; do not duplicate).

New migration `cdk/sql/2026-08-07-scope-pg-net.sql` (REPLACES the posture of `lockdown-pg-net.sql` per Justin's approved posture change):
- Drop the blanket `REVOKE EXECUTE ... FROM PUBLIC/anon/authenticated`; instead create a dedicated `webhooks_admin` role, grant `EXECUTE` on `net.*` only to it (and `service_role`), keep it revoked from `anon`/`authenticated`, and add `pgaudit.role`-style coverage so every `net.http_*` call is audited. Keep `lockdown-pg-net.sql` in the tree but supersede it with a header comment pointing to the new file (do not silently delete a security control — document the change).

Host env (repo-first in `cdk/assets/render-env.sh` + `docker-compose.override.yml`, then live-applied via SSM, then `pg_notify('pgrst','reload schema')`):
- `PGRST_DB_SCHEMAS` → append `, pgmq_public` (so the Queues API is reachable like Studio). Nothing else changes.

### B. Console — Studio Database-section parity

All on the existing pg-meta client `web/src/lib/console/pgmeta.ts` (typed `/pg/tables|columns|policies|extensions` + `POST /query`), the `/api/console/*` route pattern, the `DataGrid.tsx` / `SqlConsole.tsx` components, and the `AlertDialog` / `useConfirm()` write-guard (sensitive ops → modal confirm, per controls-match-risk). New nav under the existing **Database** group.

Pages (each = a read path via pg-meta or a scoped `POST /query`, plus guarded write actions):
1. **Extensions manager** — list `pg_available_extensions` + installed; enable/disable with confirm. (pg-meta `/extensions` already fetched by the schema page.)
2. **Functions / Triggers / Indexes / Enumerated Types / Publications** — introspection lists + DDL create/drop via guarded `POST /query`; read-only detail where write parity isn't worth the risk.
3. **Roles manager** — `pg_roles` list + create/alter/drop role, membership, attributes; the risky ops behind `useConfirm`. (Foundation for Wave-4 least-privilege role.)
4. **Policy editor** — upgrade the read-only RLS viewer (`web/src/app/(app)/database/rls/page.tsx`) to create/alter/drop policies via pg-meta `/policies`; **Policy Templates** library seeded with our `rls-gate.sql`-satisfying boilerplate (per-table owner/service patterns).
5. **FK Selector** — in `TableEditor.tsx`, render a row-picker on FK columns (relationships already available as `PgRelationship` in `pgmeta.ts`); replaces free-text FK entry.
6. **Visual Schema Designer** — render-first ER canvas built from pg-meta tables + relationships (no on-canvas DDL; schema changes stay in repo migrations behind the deploy gate).
7. **Advisors** — run the Supabase `splinter` lint SQL (`security` + `performance` rule sets) on-demand and on a `pg_cron` schedule; surface findings as a read-only page. Directly backs `rls-gate.sql` and pre-pgvector index hygiene.
8. **Cron** — CRUD over `cron.job` + read `cron.job_run_details` (Studio's Integrations→Cron parity).
9. **Queues** — pgmq queues list, message peek/send/archive/delete, archive-table view (Studio's Queues parity), via `pgmq_public`.
10. **Database Webhooks** — create/list webhooks the Supabase way (a trigger calling `net.http_post`, the `supabase_functions` pattern), gated to the `webhooks_admin` role; audited.
11. **API Docs** — replace the static `web/src/app/(app)/api-reference/page.tsx` with per-table generated docs (PostgREST + GraphQL examples per table/column, Studio-style) driven from pg-meta introspection.

## Critical files

- Migrations: `cdk/sql/2026-08-07-parity-platform-extensions.sql`, `cdk/sql/2026-08-07-scope-pg-net.sql`; reconcile `cdk/sql/enable-pgaudit.sql`, supersede `cdk/sql/lockdown-pg-net.sql`; ordering + gate honored by `cdk/sql/rls-gate.sql`.
- Host: `cdk/assets/render-env.sh` (PGRST_DB_SCHEMAS), `cdk/assets/docker-compose.override.yml` if needed; new re-runnable apply procedure documented in `docs/runbooks/marketinghub-app-deploy.md` (or a new `docs/runbooks/supabase-host-apply.md`).
- Console client: extend `web/src/lib/console/pgmeta.ts` (roles, functions, triggers, indexes, enums, publications, cron, pgmq, extensions enable/disable, splinter runner) + new `web/src/lib/console/advisors.ts`.
- Routes: `web/src/app/api/console/{roles,functions,triggers,indexes,enums,publications,policies,extensions,cron,queues,webhooks,advisors}/route.ts`.
- Pages: under `web/src/app/(app)/database/*` + nav in the console layout; components in `web/src/components/console/*` (reuse `DataGrid`, `SqlConsole`, `AlertDialog`).

## Verification

- Migrations apply cleanly via SSM `docker exec supabase-db psql` (idempotent re-run = no-op); `select extname from pg_extension` shows vector/pg_cron/pgmq/wrappers/pgaudit; `pg_notify('pgrst','reload schema')`; `pgmq_public` reachable through PostgREST.
- `rls-gate.sql` still passes (new objects don't regress the gate).
- Each console page exercised end-to-end through the SSM tunnel (all routes 200 + one interactive write per page behind its confirm); cross-check state against stock Studio where Studio has the same page.
- Test suites green: `web` (Node-26 `NODE_OPTIONS=--no-experimental-webstorage`), `app-infra`, `cdk` (+ new migration/sql tests; also fix the pre-existing `data-stack.test.ts` drift if it's in the blast radius).
- Post host-change: `UnhealthyContainerCount` alarm quiet.
- Deploy: image build linux/amd64 (pipefail + `aws ecr describe-images` confirm), task-def roll, verify.

## Risks / flags for Justin

- **PG15 vs PG17 drift** — the box runs `postgres:15.8.1.085`; spec/memory say PG17. Either a planned upgrade never happened or the instance was rebuilt from an older bootstrap. Wave 1 works either way, but this needs an explicit reconcile decision (upgrade to 17, or correct the docs to 15). Not blocking; surfaced.
- **pgaudit never installed** — a documented security control (`enable-pgaudit.sql`) is not actually in effect on this DB. Wave 1 fixes it; worth knowing it was dark.
- **pg_net posture change** — re-scoping (not blanket-revoking) `net.*` is an approved, deliberate loosening; the audit coverage is the compensating control.
- **Catalog corrections to fold back** (task): analytics stack is running (not "never enabled"); pgaudit not installed; PG15 not PG17; edge-functions restart-looping confirmed live. Update `docs/reference/supabase-feature-catalog.md` + memory at wave close.
