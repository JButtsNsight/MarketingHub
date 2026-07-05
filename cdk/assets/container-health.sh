#!/usr/bin/env bash
#
# container-health.sh — host monitor for the single-node safety net (spec §16).
# ASG-style instance health is blind to a dead `db`/kong/auth container on a live
# host, so this counts non-running / unhealthy Docker Compose containers and
# publishes UnhealthyContainerCount to CloudWatch. The ObservabilityStack
# ContainerHealthAlarm (treatMissingData BREACHING) pages on-call on >=1 OR if this
# emitter stops running. Schedule from Phase 3's bootstrap (e.g. a 1-min systemd
# timer / cron) alongside the CloudWatch agent.
#
set -euo pipefail

readonly METRIC_NAMESPACE="Supabase/Containers"
readonly METRIC_NAME="UnhealthyContainerCount"
readonly AWS_REGION="${AWS_REGION:-us-east-1}"

log() { echo "[container-health] $*" >&2; }

# Count containers that are either not running or report an unhealthy healthcheck.
count_unhealthy() {
  local unhealthy exited
  # Containers with a healthcheck currently reporting unhealthy.
  unhealthy="$(docker ps --filter 'health=unhealthy' --quiet | wc -l | tr -d '[:space:]')"
  # Containers that exited/died (a crashed service on a live host).
  exited="$(docker ps --filter 'status=exited' --filter 'status=dead' --quiet \
    | wc -l | tr -d '[:space:]')"
  echo $(( unhealthy + exited ))
}

main() {
  local n
  n="$(count_unhealthy)"
  aws cloudwatch put-metric-data \
    --namespace "$METRIC_NAMESPACE" \
    --metric-name "$METRIC_NAME" \
    --value "$n" \
    --unit Count \
    --region "$AWS_REGION" >/dev/null 2>&1 \
    || log "WARNING: could not publish ${METRIC_NAME}=${n} to CloudWatch"
  log "Published ${METRIC_NAME}=${n}."
}

main "$@"
