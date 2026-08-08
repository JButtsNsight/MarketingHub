#!/usr/bin/env bash
#
# scripts/gen-db-types.sh — regenerate web/src/lib/database.types.ts
#
# WHAT THIS DOES
#   1. Starts an ephemeral supabase/postgres:15.8.1.085 container (the exact
#      pinned prod image — bundle supabase/supabase@v1.26.05) on a random
#      localhost port.
#   2. Applies the BARE-IMAGE SHIMS below, then every DATED migration in
#      cdk/sql/ (YYYY-MM-DD-*.sql) in lexicographic order as supabase_admin
#      with ON_ERROR_STOP=1, then RE-APPLIES the engagement-suite migration
#      LAST (see ORDERING). Utility files (rls-gate.sql, enable-*.sql,
#      lockdown-*.sql) are NOT part of the dated chain and are skipped.
#   3. Runs `npx supabase@2.113.0 gen types typescript` against the container
#      (--db-url mode; the CLI spawns a postgres-meta introspection container,
#      so Docker is REQUIRED on this machine) for schemas
#      marketinghub,public,storage,vault.
#   4. Writes web/src/lib/database.types.ts with a header carrying the sha256
#      of the sorted dated migration files concatenated. The drift guard test
#      web/src/lib/database.types.test.ts recomputes that hash — when the
#      dated chain changes, the test fails until this script is re-run.
#   5. Always tears the container down (trap on EXIT), success or failure.
#
# ORDERING (docs/runbooks/marketinghub-app-deploy.md)
#   * Dated migrations apply in date (= lexicographic) order — §1.6.
#   * §1.6b gotcha: 2026-07-22-sms-campaigns.sql drops AND re-creates the
#     2-arg claim_due_sms_recipients; 2026-08-05-engagement-suite.sql replaces
#     it with the 4-arg version. The engagement-suite migration must therefore
#     always be (re-)applied LAST, or PostgREST RPC resolution turns ambiguous.
#     Verified here: after the re-apply, exactly ONE overload (4-arg) exists.
#   * Tail today: ...w4-user-rls.sql -> w5-realtime.sql (-> w7-backups-vault.sql
#     once committed — the glob picks up new dated files automatically; re-run
#     this script whenever the chain changes).
#
# BARE-IMAGE SHIMS (ephemeral container ONLY — never applied to a real host,
# and migrations are NEVER edited to accommodate them)
#   * `create extension if not exists pg_net` — on the real host the bundle's
#     compose/init creates pg_net; the bare image only ships the binaries.
#     2026-08-07-scope-pg-net.sql references net.http_get/post/delete.
#   * realtime.messages + realtime.topic() + realtime.send() — on the real
#     host the realtime container's tenant migrations create these at boot
#     (SEED_SELF_HOST=true); 2026-08-08-w5-realtime.sql fails loud without
#     them (by design — it never creates realtime-owned objects). The shim
#     mirrors the tenant-migration shapes (daily-partitioned messages table,
#     RLS enabled) with a no-op send(). The realtime schema itself already
#     exists (empty) in the bare image.
#   * _realtime.tenants is deliberately NOT shimmed — w5's tenant-hardening
#     block is guarded and self-skips with a NOTICE (runbook §10.4 accepted
#     risk), matching a realtime image without the private_only column.
#   None of the shimmed schemas (realtime/net) are in the generated --schema
#   list, so shims cannot leak into the generated types.
#
# REQUIREMENTS: docker (daemon running), node/npx, network on first run to
# pull supabase/postgres:15.8.1.085 + the supabase@2.113.0 CLI + its
# postgres-meta image (all cached afterwards).
#
# USAGE: bash scripts/gen-db-types.sh   (or, from web/: npm run gen:types)

set -euo pipefail
export LC_ALL=C

IMAGE="supabase/postgres:15.8.1.085"
CLI_PKG="supabase@2.113.0"
SCHEMAS="marketinghub,public,storage,vault"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_DIR="$REPO_ROOT/cdk/sql"
OUT_FILE="$REPO_ROOT/web/src/lib/database.types.ts"
ENGAGEMENT_SUITE="$SQL_DIR/2026-08-05-engagement-suite.sql"

NAME="mh-typegen-$$-$RANDOM"
PG_PASSWORD="typegen-$RANDOM$RANDOM"
CONTAINER_STARTED=0

log() { printf '[gen-db-types] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

cleanup() {
  if [ "$CONTAINER_STARTED" = "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    log "tore down container $NAME"
  fi
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "docker is required (the CLI's --db-url mode also spawns a postgres-meta container)"
docker info >/dev/null 2>&1 || die "docker daemon is not reachable"
[ -d "$SQL_DIR" ] || die "cdk/sql not found at $SQL_DIR"

# --- collect the dated chain (lexicographic = date order) --------------------
DATED_FILES=""
for f in "$SQL_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*.sql; do
  [ -e "$f" ] || die "no dated migrations matched in $SQL_DIR"
  DATED_FILES="$DATED_FILES$f"$'\n'
done
DATED_FILES="${DATED_FILES%$'\n'}"
[ -f "$ENGAGEMENT_SUITE" ] || die "engagement-suite migration missing ($ENGAGEMENT_SUITE) — its LAST re-apply is mandatory (runbook §1.6b)"

# sha256 of the sorted dated files concatenated (drift-guard contract: the
# web test web/src/lib/database.types.test.ts recomputes exactly this).
if command -v shasum >/dev/null 2>&1; then
  MIGRATIONS_HASH="$(printf '%s\n' "$DATED_FILES" | tr '\n' '\0' | xargs -0 cat | shasum -a 256 | cut -d' ' -f1)"
else
  MIGRATIONS_HASH="$(printf '%s\n' "$DATED_FILES" | tr '\n' '\0' | xargs -0 cat | sha256sum | cut -d' ' -f1)"
fi
log "dated chain ($(printf '%s\n' "$DATED_FILES" | grep -c .) files) sha256:$MIGRATIONS_HASH"

# --- start the ephemeral pinned image on a random localhost port -------------
PORT=""
for _try in 1 2 3 4 5; do
  CANDIDATE=$(( (RANDOM % 1000) + 54000 ))
  if docker run -d --name "$NAME" -p "127.0.0.1:$CANDIDATE:5432" \
       -e POSTGRES_PASSWORD="$PG_PASSWORD" "$IMAGE" >/dev/null 2>&1; then
    PORT="$CANDIDATE"
    CONTAINER_STARTED=1
    break
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
done
[ -n "$PORT" ] || die "could not start $IMAGE on a random port after 5 attempts"
log "started $IMAGE as $NAME on 127.0.0.1:$PORT"

PSQL="docker exec -i -e PGPASSWORD=$PG_PASSWORD $NAME psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q"

# Ready = init scripts finished (supabase roles exist), not just port-open —
# the image restarts the server once during initdb.
READY=0
for _i in $(seq 1 60); do
  if $PSQL -Atc "select 1 from pg_roles where rolname = 'authenticated'" 2>/dev/null | grep -q 1; then
    READY=1
    break
  fi
  sleep 2
done
[ "$READY" = "1" ] || die "container did not become ready in 120s (docker logs $NAME)"
log "container ready (supabase roles present)"

# --- bare-image shims (see header) -------------------------------------------
$PSQL <<'SHIMS'
begin;
-- shim: pg_net — created by the bundle's init on the real host; the bare
-- image only ships it. scope-pg-net references net.http_get/post/delete.
create extension if not exists pg_net;
-- shim: realtime tenant objects — created by the realtime container at boot
-- on the real host; w5-realtime fails loud without them (by design).
create table if not exists realtime.messages (
  topic       text not null,
  extension   text not null,
  payload     jsonb,
  event       text,
  private     boolean default false,
  updated_at  timestamp without time zone not null default now(),
  inserted_at timestamp without time zone not null default now(),
  id          uuid not null default gen_random_uuid(),
  primary key (id, inserted_at)
) partition by range (inserted_at);
alter table realtime.messages enable row level security;
create or replace function realtime.topic()
returns text
language sql stable
as $fn$ select nullif(current_setting('realtime.topic', true), '')::text $fn$;
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void
language plpgsql
as $fn$ begin null; end $fn$;
commit;
SHIMS
log "bare-image shims applied"

# --- apply the dated chain, then engagement-suite LAST (runbook §1.6b) -------
printf '%s\n' "$DATED_FILES" | while IFS= read -r f; do
  log "applying $(basename "$f")"
  $PSQL < "$f" >/dev/null
done
log "re-applying $(basename "$ENGAGEMENT_SUITE") LAST (runbook §1.6b — claim RPC)"
$PSQL < "$ENGAGEMENT_SUITE" >/dev/null

# Sanity: exactly one claim_due_sms_recipients overload (the 4-arg one).
OVERLOADS="$($PSQL -Atc "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'marketinghub' and p.proname = 'claim_due_sms_recipients'")"
[ "$OVERLOADS" = "1" ] || die "expected exactly 1 claim_due_sms_recipients overload after the engagement-suite re-apply, found $OVERLOADS (runbook §1.6b)"
log "claim RPC state verified (single 4-arg overload)"

# --- generate ----------------------------------------------------------------
TMP_TYPES="$(mktemp)"
trap 'rm -f "$TMP_TYPES"; cleanup' EXIT
log "running npx $CLI_PKG gen types (spawns a postgres-meta container)"
npx -y "$CLI_PKG" gen types typescript \
  --db-url "postgresql://supabase_admin:$PG_PASSWORD@127.0.0.1:$PORT/postgres" \
  --schema "$SCHEMAS" > "$TMP_TYPES"

grep -q "export type Database" "$TMP_TYPES" || die "generated output missing 'export type Database' — refusing to write"
grep -q "sms_campaigns" "$TMP_TYPES" || die "generated output missing marketinghub tables — refusing to write"

{
  printf '// generated by scripts/gen-db-types.sh — migrations sha256:%s\n' "$MIGRATIONS_HASH"
  printf '// generated %s from the dated cdk/sql chain applied to an ephemeral %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE"
  printf '// do not edit by hand — re-run: bash scripts/gen-db-types.sh\n'
  cat "$TMP_TYPES"
} > "$OUT_FILE"

log "wrote $OUT_FILE ($(wc -l < "$OUT_FILE" | tr -d ' ') lines)"
log "done"
