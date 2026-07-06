#!/usr/bin/env bash
#
# Supabase host bootstrap — fail-loud, idempotent.
# Runs as root via EC2 user-data on AL2023. Converges against the persistent
# data volume on every re-run. See spec §7, §10, §13.
#
set -euo pipefail

# ---- Tunables (the Supabase bundle is PINNED; PG17 per spec §22) ----------------
readonly SUPABASE_REF="v2.30.4"                 # pin the bundle tag/release (PG17)
readonly SUPABASE_REPO="https://github.com/supabase/supabase.git"
readonly APP_DIR="/opt/supabase"                # compose project lives here (root vol)
readonly DATA_MOUNT="/mnt/pgdata"               # the dedicated EBS data volume
readonly DATA_DEVICE_HINT="/dev/nvme1n1"        # Nitro name for the second EBS volume
readonly SENTINEL="${DATA_MOUNT}/.supabase-initialized"
readonly PGDATA_DIR="${DATA_MOUNT}/db/data"     # PGDATA
readonly PGWAL_DIR="${DATA_MOUNT}/db/wal"       # pg_wal — SAME volume as PGDATA
readonly FUNCTIONS_DIR="${DATA_MOUNT}/functions"
export AWS_REGION="us-east-1"   # exported (not readonly): render_env passes it as a command-prefix env, which bash forbids on a readonly var
readonly STANZA="supabase"              # pgBackRest stanza (matches pgbackrest.conf)
readonly DB_CONTAINER="supabase-db"     # pinned bundle's db container name
# Secret ARNs are injected by user-data (rendered from CDK); fail if unset.
: "${APP_CONFIG_SECRET_ARN:?APP_CONFIG_SECRET_ARN must be set by user-data}"
: "${SERVICE_ROLE_SECRET_ARN:?SERVICE_ROLE_SECRET_ARN must be set by user-data}"
: "${STORAGE_CREDS_SECRET_ARN:?STORAGE_CREDS_SECRET_ARN must be set by user-data}"
: "${SMTP_SECRET_ARN:?SMTP_SECRET_ARN must be set by user-data}"
: "${STORAGE_BUCKET:?STORAGE_BUCKET must be set by user-data}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET must be set by user-data}"

log()  { echo "[bootstrap] $*" >&2; }
die()  { echo "[bootstrap][FATAL] $*" >&2; exit 1; }

# ---- 1. IMDSv2 token (hop-limit 1; the host can reach IMDS) ----------------------
imds_token() {
  curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300"
}
require_imds() {
  local tok
  tok="$(imds_token)" || die "IMDSv2 token request failed — cannot proceed"
  [ -n "$tok" ] || die "Empty IMDSv2 token"
  log "IMDSv2 reachable."
}

# ---- 2. Docker + compose plugin + deps (AL2023) ----------------------------------
install_docker() {
  # jq is required by render-env.sh; git by fetch_bundle. Install alongside docker.
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
     && command -v jq >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    log "Docker + compose + deps already present."
  else
    log "Installing Docker + compose plugin + deps (git, jq)."
    dnf -y install docker git jq
    # compose v2 plugin
    mkdir -p /usr/libexec/docker/cli-plugins
    local cver="v2.29.7"
    curl -fsSL \
      "https://github.com/docker/compose/releases/download/${cver}/docker-compose-linux-x86_64" \
      -o /usr/libexec/docker/cli-plugins/docker-compose
    chmod 0755 /usr/libexec/docker/cli-plugins/docker-compose
  fi
  systemctl enable --now docker
  # Docker log rotation (spec §7) — bound container log growth on the root volume.
  install -d -m 0755 /etc/docker
  cat >/etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
JSON
  systemctl restart docker
  docker compose version >/dev/null 2>&1 || die "docker compose plugin not usable"
}

# ---- 3. Mount the data volume BY UUID (Nitro-safe) -------------------------------
resolve_data_device() {
  # Prefer the hint; else pick the first non-root, unmounted, unpartitioned disk.
  if [ -b "$DATA_DEVICE_HINT" ]; then echo "$DATA_DEVICE_HINT"; return 0; fi
  local dev
  dev="$(lsblk -dno NAME,TYPE | awk '$2=="disk"{print "/dev/"$1}' \
        | grep -vE 'nvme0n1$' | head -n1 || true)"
  [ -n "$dev" ] || die "Could not resolve the data device"
  echo "$dev"
}
mount_data_volume() {
  local dev fstype uuid
  dev="$(resolve_data_device)"
  fstype="$(blkid -o value -s TYPE "$dev" 2>/dev/null || true)"
  install -d -m 0755 "$DATA_MOUNT"
  if [ -z "$fstype" ]; then
    # Blank device. It is legitimate to format ONLY on a truly first-ever boot; the
    # sentinel/abort logic (step 4) guards against wiping a populated-but-unmounted vol.
    log "Data device $dev is unformatted — formatting ext4 (first-ever boot)."
    mkfs.ext4 -m 0 "$dev"
  fi
  uuid="$(blkid -o value -s UUID "$dev")"
  [ -n "$uuid" ] || die "No UUID for $dev after format"
  # Idempotent fstab entry by UUID (Nitro renames devices; UUID is stable).
  if ! grep -q "UUID=${uuid}" /etc/fstab; then
    printf 'UUID=%s  %s  ext4  defaults,nofail  0  2\n' "$uuid" "$DATA_MOUNT" >>/etc/fstab
  fi
  mountpoint -q "$DATA_MOUNT" || mount "$DATA_MOUNT"
  mountpoint -q "$DATA_MOUNT" || die "Failed to mount data volume at $DATA_MOUNT"
  log "Data volume mounted by UUID=$uuid at $DATA_MOUNT."
}

# ---- 4. Sentinel branch (fail-loud on the data-loss trap) ------------------------
# A volume is "populated" if PGDATA has a PG control file. If the sentinel is present
# we start WITHOUT re-init. If PGDATA looks populated but the sentinel is missing (or
# vice-versa) we ABORT rather than initialize a fresh DB over real data.
data_state() {
  local has_sentinel="no" has_pgdata="no"
  [ -f "$SENTINEL" ] && has_sentinel="yes"
  [ -f "${PGDATA_DIR}/PG_VERSION" ] && has_pgdata="yes"
  echo "${has_sentinel}:${has_pgdata}"
}

# ---- 6. Fetch secrets WITHOUT echo, render .env chmod 600 ------------------------
fetch_secret_json() {  # $1 = ARN ; prints raw JSON to stdout (caller must not log it)
  aws secretsmanager get-secret-value \
    --secret-id "$1" --region "$AWS_REGION" \
    --query SecretString --output text
}
render_env() {
  set +x  # never trace secret handling
  install -d -m 0755 "$APP_DIR"
  local envfile="${APP_DIR}/.env"
  umask 077
  # render-env.sh maps the Secrets Manager JSON -> compose env (see Task 5).
  APP_CONFIG_JSON="$(fetch_secret_json "$APP_CONFIG_SECRET_ARN")" \
  SERVICE_ROLE_JSON="$(fetch_secret_json "$SERVICE_ROLE_SECRET_ARN")" \
  STORAGE_CREDS_JSON="$(fetch_secret_json "$STORAGE_CREDS_SECRET_ARN")" \
  SMTP_JSON="$(fetch_secret_json "$SMTP_SECRET_ARN")" \
  STORAGE_BUCKET="$STORAGE_BUCKET" AWS_REGION="$AWS_REGION" \
    bash "${APP_DIR}/render-env.sh" >"$envfile"
  chown root:root "$envfile"
  chmod 600 "$envfile"
  [ -s "$envfile" ] || die ".env render produced an empty file"
  log ".env rendered (600, root-owned). Contents intentionally not logged."
}

# ---- 8. Fetch the pinned bundle, wire overrides, bring the stack up --------------
fetch_bundle() {
  if [ ! -d "${APP_DIR}/.git" ]; then
    log "Cloning Supabase bundle @ ${SUPABASE_REF}."
    git clone --depth 1 --branch "$SUPABASE_REF" "$SUPABASE_REPO" /tmp/supabase-src
    install -d -m 0755 "$APP_DIR"
    cp -a /tmp/supabase-src/docker/. "$APP_DIR"/
    rm -rf /tmp/supabase-src
  else
    log "Bundle already present at $APP_DIR (pinned ${SUPABASE_REF})."
  fi
  # Drop our override + env renderer alongside the compose file (delivered via user-data
  # asset staging; here we assert they exist).
  [ -f "${APP_DIR}/docker-compose.yml" ] || die "compose file missing from bundle"
  [ -f "${APP_DIR}/docker-compose.override.yml" ] || die "override file not staged"
  [ -f "${APP_DIR}/render-env.sh" ] || die "render-env.sh not staged"
}
compose_up() {
  cd "$APP_DIR"
  # Do NOT enable analytics/vector (spec §5) — we never run `run.sh config add logs`,
  # and the override removes any depends_on: analytics edges on older tags.
  docker compose --env-file "${APP_DIR}/.env" up -d
}

# ---- 9. Backups: pgBackRest WAL/PITR + full/diff schedule + nightly pg_dump (§9) -----
install_backup_deps() {
  if command -v pgbackrest >/dev/null 2>&1 && command -v crond >/dev/null 2>&1; then
    log "pgBackRest + cron already present."
  else
    log "Installing pgBackRest + cronie."
    dnf -y install pgbackrest cronie
  fi
  command -v pgbackrest >/dev/null 2>&1 || die "pgbackrest not installed — cannot back up"
  command -v crond >/dev/null 2>&1 || die "crond not installed — cannot schedule backups"
}

wait_for_db() {
  # Bounded readiness wait (~5 min) before touching Postgres for backup wiring.
  local i=0
  while [ "$i" -lt 60 ]; do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
      log "Postgres is ready."
      return 0
    fi
    i=$((i + 1))
    sleep 5
  done
  die "Postgres did not become ready — cannot configure backups"
}

configure_wal_archiving() {
  # Continuous WAL archiving to pgBackRest → PITR, RPO ≤ 5 min (§9). archive_mode
  # requires a full server restart, so ALTER SYSTEM then restart the db container.
  log "Enabling WAL archiving (archive_mode + archive_command)."
  docker exec "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 \
    -c "ALTER SYSTEM SET archive_mode = 'on';" \
    -c "ALTER SYSTEM SET archive_command = 'pgbackrest --stanza=${STANZA} archive-push %p';" \
    || die "failed to set archive_mode/archive_command on the db"
  ( cd "$APP_DIR" && docker compose --env-file "${APP_DIR}/.env" restart db ) \
    || die "failed to restart db to apply archive_mode"
  wait_for_db
}

install_backup_schedule() {
  # full weekly (Sun 02:00), diff daily (Mon–Sat 02:00), nightly pg_dump (03:00). §9.
  install -d -m 0755 /etc/cron.d
  cat >/etc/cron.d/nsight-pgbackrest <<CRON
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
BACKUP_BUCKET=${BACKUP_BUCKET}
AWS_REGION=${AWS_REGION}
0 2 * * 0 root /usr/local/bin/pgbackrest-cron full
0 2 * * 1-6 root /usr/local/bin/pgbackrest-cron diff
0 3 * * * root /usr/local/bin/pgbackrest-cron dump
CRON
  chmod 0644 /etc/cron.d/nsight-pgbackrest
  systemctl enable --now crond || die "crond could not be started — backups not scheduled"
}

setup_backups() {
  # Preview profile: SKIP_BACKUPS is exported from user-data (rendered by CDK). When set
  # (non-empty) we skip ALL pgBackRest/WAL/cron wiring — it is the riskiest first-boot
  # step and the backup vault does not exist in a preview stack. Fail-loud otherwise.
  if [ -n "${SKIP_BACKUPS:-}" ]; then
    log "skipping backups (preview)"
    return 0
  fi
  export BACKUP_BUCKET AWS_REGION
  install_backup_deps
  wait_for_db
  configure_wal_archiving
  # Initialize + verify the pgBackRest S3 stanza (host process, instance-role creds).
  /usr/local/bin/pgbackrest-cron stanza || die "pgBackRest stanza init/check failed"
  install_backup_schedule
  log "Backups active: WAL archiving + full/diff base backups + nightly pg_dump scheduled."
}

main() {
  require_imds
  install_docker
  mount_data_volume

  local state; state="$(data_state)"
  case "$state" in
    yes:yes)
      log "Populated data volume + sentinel present — attaching WITHOUT re-init."
      ;;
    no:yes)
      die "PGDATA is populated but the sentinel is MISSING — refusing to re-init over real data. Investigate ${PGDATA_DIR}."
      ;;
    yes:no)
      die "Sentinel present but PGDATA is EMPTY — data volume did not attach or was wiped. Refusing to initialize a fresh DB. Investigate ${DATA_MOUNT}."
      ;;
    no:no)
      log "First-ever boot on a blank volume — initializing fresh Supabase state."
      install -d -m 0700 "$PGDATA_DIR" "$PGWAL_DIR"
      install -d -m 0755 "$FUNCTIONS_DIR"
      ;;
    *)
      die "Unknown data-volume state: $state"
      ;;
  esac

  # Invariant: PGDATA and pg_wal both live on the data volume (snapshot coherence, §7).
  case "$PGWAL_DIR" in "${DATA_MOUNT}"/*) : ;; *) die "pg_wal must live on the data volume";; esac
  case "$PGDATA_DIR" in "${DATA_MOUNT}"/*) : ;; *) die "PGDATA must live on the data volume";; esac
  install -d -m 0755 "$FUNCTIONS_DIR"

  render_env
  fetch_bundle
  compose_up

  # Activate the §9 backup machinery: WAL archiving (PITR), scheduled full/diff base
  # backups, and the nightly pg_dump. Runs on every boot (idempotent — ALTER SYSTEM,
  # stanza-create, and the cron.d drop are all convergent).
  setup_backups

  # First-boot only: stamp the sentinel AFTER a clean bring-up so a crashed init does
  # not falsely mark the volume initialized.
  if [ "$state" = "no:no" ] && [ -f "${PGDATA_DIR}/PG_VERSION" ]; then
    date -u +%FT%TZ >"$SENTINEL"
    log "Sentinel stamped — future boots will attach without re-init."
  fi
  log "Bootstrap complete."
}

main "$@"
