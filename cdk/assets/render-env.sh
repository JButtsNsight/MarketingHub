#!/usr/bin/env bash
#
# render-env.sh — assemble the compose .env for the pinned Supabase bundle.
#
# The authoritative variable list is the bundle's own docker/.env.example (staged
# into APP_DIR by bootstrap.sh and passed here as ENV_EXAMPLE). We take that file
# VERBATIM as the base — so every variable the pinned docker-compose.yml references
# (POSTGRES_*, KONG_*, PGRST_*, IMGPROXY_*, LOGFLARE_*, STUDIO_*, POOLER_*,
# DOCKER_SOCKET_LOCATION, FUNCTIONS_VERIFY_JWT, …) keeps a sane shipped default and
# `docker compose` no longer warns/fatally-fails on undefined vars — then SET-OR-REPLACE
# ONLY the handful of values we manage (secrets, schema list, S3 backend, host URLs).
#
# Secrets Manager JSON is passed as env vars by bootstrap.sh. This script NEVER echoes
# secrets to a log; it only writes the finished .env to stdout, which bootstrap.sh
# redirects into a chmod-600 root-owned .env. (§10, §13)
#
set -euo pipefail
set +x  # never trace secret handling
umask 077  # any temp file we create is 600

: "${APP_CONFIG_JSON:?}"
: "${SERVICE_ROLE_JSON:?}"
: "${STORAGE_CREDS_JSON:?}"
: "${SMTP_JSON:?}"
: "${STORAGE_BUCKET:?}"
: "${AWS_REGION:?}"
: "${ENV_EXAMPLE:?ENV_EXAMPLE must point at the bundle .env.example base}"
: "${HOST_PRIVATE_IP:?HOST_PRIVATE_IP must be the host private IPv4 for the service URLs}"

die() { echo "[render-env][FATAL] $*" >&2; exit 1; }

[ -f "$ENV_EXAMPLE" ] || die "base env file not found: $ENV_EXAMPLE (bundle not staged?)"

jget() { printf '%s' "$2" | jq -er --arg k "$1" '.[$k]'; }

# --- App config (crown-jewel + operational secrets) ---
POSTGRES_PASSWORD="$(jget POSTGRES_PASSWORD "$APP_CONFIG_JSON")"
JWT_SECRET="$(jget JWT_SECRET "$APP_CONFIG_JSON")"
ANON_KEY="$(jget ANON_KEY "$APP_CONFIG_JSON")"
SECRET_KEY_BASE="$(jget SECRET_KEY_BASE "$APP_CONFIG_JSON")"
VAULT_ENC_KEY="$(jget VAULT_ENC_KEY "$APP_CONFIG_JSON")"

# --- Crown-jewel length validation (§13) — fail loud at bootstrap, not later as an
#     opaque GoTrue/Vault crash-loop after `docker compose up`. Lengths are counted in
#     characters (these secrets are ASCII), matching the spec's stated requirements. ---
[ "${#SECRET_KEY_BASE}" -ge 64 ] \
  || die "SECRET_KEY_BASE must be >= 64 chars (got ${#SECRET_KEY_BASE})"
[ "${#VAULT_ENC_KEY}" -eq 32 ] \
  || die "VAULT_ENC_KEY must be exactly 32 chars (got ${#VAULT_ENC_KEY})"
PG_META_CRYPTO_KEY="$(jget PG_META_CRYPTO_KEY "$APP_CONFIG_JSON")"
POOLER_TENANT_ID="$(jget POOLER_TENANT_ID "$APP_CONFIG_JSON")"
DASHBOARD_USERNAME="$(jget DASHBOARD_USERNAME "$APP_CONFIG_JSON")"
DASHBOARD_PASSWORD="$(jget DASHBOARD_PASSWORD "$APP_CONFIG_JSON")"
S3_PROTOCOL_ACCESS_KEY_ID="$(jget S3_PROTOCOL_ACCESS_KEY_ID "$APP_CONFIG_JSON")"
S3_PROTOCOL_ACCESS_KEY_SECRET="$(jget S3_PROTOCOL_ACCESS_KEY_SECRET "$APP_CONFIG_JSON")"

# --- service_role (BYPASSRLS crown jewel; server-side only) ---
SERVICE_ROLE_KEY="$(jget SERVICE_ROLE_KEY "$SERVICE_ROLE_JSON")"

# --- Storage bucket-scoped IAM creds (§10) — Storage service ONLY ---
STORAGE_AWS_ACCESS_KEY_ID="$(jget AWS_ACCESS_KEY_ID "$STORAGE_CREDS_JSON")"
STORAGE_AWS_SECRET_ACCESS_KEY="$(jget AWS_SECRET_ACCESS_KEY "$STORAGE_CREDS_JSON")"

# --- SES SMTP (placeholders until SES prod access — §20.1) ---
SMTP_USER="$(jget SMTP_USER "$SMTP_JSON")"
SMTP_PASS="$(jget SMTP_PASS "$SMTP_JSON")"

# In-VPC service URL. Preview/self-hosted have no external DNS, so Auth callbacks, email
# links and Studio all point at Kong on this host's private IP (§ compute-stack preview).
HOST_URL="http://${HOST_PRIVATE_IP}:8000"

# ------------------------------------------------------------------------------------
# Build the effective .env = .env.example base + our overrides, in a 600 temp file.
# ------------------------------------------------------------------------------------
WORK="$(mktemp)"
trap 'rm -f "$WORK"' EXIT
cp "$ENV_EXAMPLE" "$WORK"

# set_or_replace KEY VALUE — replace the first `^KEY=` line in $WORK if present, else
# append `KEY=VALUE`. KEY is matched as a LITERAL line prefix (awk index, not regex) and
# VALUE is passed via the environment (not awk -v, which processes backslash escapes), so
# base64/hex/UUID secret values with +, /, = are emitted byte-for-byte and can never be
# mis-interpreted as a pattern/delimiter.
set_or_replace() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  RE_KEY="$key" RE_VAL="$val" awk '
    BEGIN { k = ENVIRON["RE_KEY"]; v = ENVIRON["RE_VAL"]; done = 0 }
    (!done && index($0, k "=") == 1) { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$WORK" >"$tmp"
  mv "$tmp" "$WORK"
}

# set_if_absent KEY VALUE — append `KEY=VALUE` only if no `^KEY=` line exists (keeps the
# bundle's shipped default when present).
set_if_absent() {
  local key="$1" val="$2"
  grep -q "^${key}=" "$WORK" || printf '%s=%s\n' "$key" "$val" >>"$WORK"
}

# Postgres (bundle defaults match, but pin them explicitly).
set_or_replace POSTGRES_HOST "db"
set_or_replace POSTGRES_PORT "5432"
set_or_replace POSTGRES_DB "postgres"
set_or_replace POSTGRES_PASSWORD "$POSTGRES_PASSWORD"

# JWT / auth. Keep the bundle's JWT_EXPIRY default if present, else fall back to 3600.
set_or_replace JWT_SECRET "$JWT_SECRET"
set_or_replace ANON_KEY "$ANON_KEY"
set_or_replace SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
set_if_absent  JWT_EXPIRY "3600"

# Dashboard (Studio basic-auth via Kong).
set_or_replace DASHBOARD_USERNAME "$DASHBOARD_USERNAME"
set_or_replace DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD"

# Misc secrets the bundle expects (Realtime/Supavisor/postgres-meta).
set_or_replace SECRET_KEY_BASE "$SECRET_KEY_BASE"
set_or_replace VAULT_ENC_KEY "$VAULT_ENC_KEY"
set_or_replace PG_META_CRYPTO_KEY "$PG_META_CRYPTO_KEY"
set_or_replace POOLER_TENANT_ID "$POOLER_TENANT_ID"

# PostgREST exposed schemas — MUST include marketinghub (the app queries that schema via
# Accept-Profile: marketinghub; without it every service_role query fails PGRST106).
set_or_replace PGRST_DB_SCHEMAS "public,storage,graphql_public,marketinghub"

# Storage S3 backend: the bundle storage service reads GLOBAL_S3_BUCKET + REGION and the
# S3 protocol endpoint creds from the .env directly. (STORAGE_TENANT_ID keeps the example
# default.) The bucket-scoped IAM creds + `s3` backend switch are wired onto the storage
# service ONLY, via docker-compose.override.yml, from the STORAGE_* vars appended below.
set_or_replace GLOBAL_S3_BUCKET "$STORAGE_BUCKET"
set_or_replace REGION "$AWS_REGION"
set_or_replace S3_PROTOCOL_ACCESS_KEY_ID "$S3_PROTOCOL_ACCESS_KEY_ID"
set_or_replace S3_PROTOCOL_ACCESS_KEY_SECRET "$S3_PROTOCOL_ACCESS_KEY_SECRET"

# SES SMTP for GoTrue (empty until SES prod access is granted — §20.1).
set_or_replace SMTP_USER "$SMTP_USER"
set_or_replace SMTP_PASS "$SMTP_PASS"

# Service URLs — no external DNS in this deployment, so Auth callbacks/email links and
# Studio all resolve to Kong on this host's private IP.
set_or_replace SITE_URL "$HOST_URL"
set_or_replace API_EXTERNAL_URL "$HOST_URL"
set_or_replace SUPABASE_PUBLIC_URL "$HOST_URL"

# --- NSight custom vars consumed by docker-compose.override.yml (storage service ONLY) ---
# These are NOT bundle .env.example keys; the override injects them into the storage
# container to force the s3 backend and hand it the bucket-scoped IAM credentials. AWS
# creds are emitted ONLY under the STORAGE_-prefixed names — never as bare AWS_* env,
# which would override the credential chain of every other service and break auth (§10).
cat >>"$WORK" <<ENV

# --- NSight storage-service overrides (docker-compose.override.yml) ---
STORAGE_BACKEND=s3
STORAGE_S3_FORCE_PATH_STYLE=false
STORAGE_S3_BUCKET=${STORAGE_BUCKET}
STORAGE_S3_REGION=${AWS_REGION}
STORAGE_AWS_ACCESS_KEY_ID=${STORAGE_AWS_ACCESS_KEY_ID}
STORAGE_AWS_SECRET_ACCESS_KEY=${STORAGE_AWS_SECRET_ACCESS_KEY}
ENV

# --- WAVE-3 CUTOVER, DO NOT UNCOMMENT (staged 2026-08-08 by Wave 4) -------------------
# GoTrue custom-access-token hook wiring. The pg function stub it points at
# (marketinghub.custom_access_token_hook — returns the event untouched) ships in
# cdk/sql/2026-08-08-w4-user-rls.sql, EXECUTE granted to supabase_auth_admin only.
# GoTrue is NOT the front door yet (identity is Cognito via the ALB; Wave-4 user JWTs
# are minted by the app, not GoTrue), so enabling this hook does nothing useful today —
# it activates only at the Wave-3 GoTrue/SAML cutover.
# NOTE: the last var is _SECRETS (PLURAL). supabase/auth's example.env shows a singular
# GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_SECRET at v2.186.0, which does NOT match the envconfig
# binding — the compose and configuration.go both say _SECRETS. It is only consumed by
# https:// hook URIs and stays empty for pg-functions://.
#
# cat >>"$WORK" <<'ENV'
#
# # --- GoTrue custom access token hook (Wave-3 cutover) ---
# GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
# GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/marketinghub/custom_access_token_hook
# GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS=
# ENV
# ---------------------------------------------------------------------------------------

# Emit the finished .env on stdout (bootstrap.sh redirects to a 600 root-owned file).
cat "$WORK"
