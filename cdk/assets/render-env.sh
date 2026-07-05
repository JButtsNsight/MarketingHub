#!/usr/bin/env bash
#
# render-env.sh — map Secrets Manager JSON (passed as env vars by bootstrap.sh)
# into the compose .env on stdout. NEVER echoes secrets to a log; only writes stdout,
# which bootstrap.sh redirects into a chmod-600 root-owned .env. (§10, §13)
#
set -euo pipefail
set +x  # never trace secret handling

: "${APP_CONFIG_JSON:?}"
: "${SERVICE_ROLE_JSON:?}"
: "${STORAGE_CREDS_JSON:?}"
: "${SMTP_JSON:?}"
: "${STORAGE_BUCKET:?}"
: "${AWS_REGION:?}"

die() { echo "[render-env][FATAL] $*" >&2; exit 1; }

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

# --- SES SMTP ---
SMTP_USER="$(jget SMTP_USER "$SMTP_JSON")"
SMTP_PASS="$(jget SMTP_PASS "$SMTP_JSON")"

# Emit the compose .env. NOTE: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are
# emitted ONLY as the STORAGE_-prefixed vars consumed by the storage service in the
# override. They are deliberately NOT emitted as bare env for any other service —
# rendering them blank would OVERRIDE the credential chain and break auth (§10).
cat <<ENV
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
ANON_KEY=${ANON_KEY}
SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
SECRET_KEY_BASE=${SECRET_KEY_BASE}
VAULT_ENC_KEY=${VAULT_ENC_KEY}
PG_META_CRYPTO_KEY=${PG_META_CRYPTO_KEY}
POOLER_TENANT_ID=${POOLER_TENANT_ID}
DASHBOARD_USERNAME=${DASHBOARD_USERNAME}
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}
S3_PROTOCOL_ACCESS_KEY_ID=${S3_PROTOCOL_ACCESS_KEY_ID}
S3_PROTOCOL_ACCESS_KEY_SECRET=${S3_PROTOCOL_ACCESS_KEY_SECRET}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
STORAGE_BACKEND=s3
STORAGE_S3_BUCKET=${STORAGE_BUCKET}
STORAGE_S3_REGION=${AWS_REGION}
STORAGE_S3_FORCE_PATH_STYLE=false
STORAGE_AWS_ACCESS_KEY_ID=${STORAGE_AWS_ACCESS_KEY_ID}
STORAGE_AWS_SECRET_ACCESS_KEY=${STORAGE_AWS_SECRET_ACCESS_KEY}
ENV
