#!/usr/bin/env bash
# cdk/scripts/rls-gate.sh
# Runs the RLS deploy gate against the target DB. EXITS NON-ZERO if ANY exposed-schema
# table is unrestricted (RLS off or zero policies). Deny-by-default release gate (spec §12).
#
# Usage:  DATABASE_URL="postgresql://user:pass@host:5432/postgres?sslmode=require" \
#           ./rls-gate.sh
# or pass a psql conninfo string as $1. Requires: psql on PATH.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
GATE_SQL="${SCRIPT_DIR}/../sql/rls-gate.sql"

CONN="${1:-${DATABASE_URL:-}}"
if [[ -z "${CONN}" ]]; then
  echo "ERROR: provide a psql connection string via \$1 or \$DATABASE_URL" >&2
  exit 2
fi
if [[ ! -f "${GATE_SQL}" ]]; then
  echo "ERROR: gate SQL not found at ${GATE_SQL}" >&2
  exit 2
fi

# -A -t: unaligned, tuples-only so we can count result lines cleanly.
# ON_ERROR_STOP so a bad query fails LOUD instead of returning empty (false pass).
OFFENDERS="$(psql "${CONN}" \
  --no-psqlrc --quiet --tuples-only --no-align \
  --set ON_ERROR_STOP=1 \
  --file "${GATE_SQL}")"

if [[ -n "${OFFENDERS}" ]]; then
  echo "RLS GATE FAILED — unrestricted exposed-schema tables detected:" >&2
  echo "${OFFENDERS}" >&2
  echo "Every offending table must ENABLE + FORCE ROW LEVEL SECURITY and carry a policy." >&2
  exit 1
fi

echo "RLS gate passed: all exposed-schema tables are RLS-enabled with policies."
exit 0
