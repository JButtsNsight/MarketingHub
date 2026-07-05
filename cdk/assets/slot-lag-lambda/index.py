"""Publishes Postgres health metrics to CloudWatch every run (spec §16):
  - MaxSlotRetainedWALBytes: max retained WAL across all replication slots.
  - ConnectionUtilizationPercent: used / max_connections (saturation).
  - PostgresUp: 1 on a successful connect+query (reachability / synthetic check).
Fails LOUD: any connection/query error raises, so PostgresUp is NOT published and
the reachability alarm (LessThanThreshold + treatMissingData BREACHING) fires.
Uses the psycopg (v3) binary bundled into the deployment package; the DB
connection string comes from Secrets Manager (read-only, scoped)."""
import json
import os

import boto3
import psycopg  # bundled via requirements.txt in the asset build

NAMESPACE = "Supabase/DB"
METRIC = "MaxSlotRetainedWALBytes"

_secrets = boto3.client("secretsmanager")
_cw = boto3.client("cloudwatch")

SLOT_QUERY = """
SELECT COALESCE(
         MAX(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)),
         0
       )::bigint AS max_retained_bytes
FROM pg_replication_slots;
"""

CONN_QUERY = """
SELECT (SELECT count(*) FROM pg_stat_activity)::float
         / NULLIF(current_setting('max_connections')::float, 0)
         * 100.0 AS conn_util_pct;
"""


def _dsn() -> str:
    secret_arn = os.environ["DB_SECRET_ARN"]
    raw = _secrets.get_secret_value(SecretId=secret_arn)["SecretString"]
    s = json.loads(raw)
    # Connect through the Supavisor session pooler (:5432) inside the VPC.
    return (
        f"host={s['host']} port={s.get('port', 5432)} "
        f"dbname={s.get('dbname', 'postgres')} "
        f"user={s['username']} password={s['password']} "
        f"sslmode=require connect_timeout=10"
    )


def handler(event, context):  # noqa: ANN001, ARG001
    with psycopg.connect(_dsn()) as conn:
        with conn.cursor() as cur:
            cur.execute(SLOT_QUERY)
            (max_bytes,) = cur.fetchone()
            cur.execute(CONN_QUERY)
            (conn_pct,) = cur.fetchone()
    # Reaching here means connect + both queries succeeded => Postgres is reachable.
    _cw.put_metric_data(
        Namespace=NAMESPACE,
        MetricData=[
            {
                "MetricName": METRIC,
                "Value": float(max_bytes),
                "Unit": "Bytes",
            },
            {
                "MetricName": "ConnectionUtilizationPercent",
                "Value": float(conn_pct or 0.0),
                "Unit": "Percent",
            },
            {
                "MetricName": "PostgresUp",
                "Value": 1.0,
                "Unit": "Count",
            },
        ],
    )
    return {
        "maxRetainedBytes": int(max_bytes),
        "connectionUtilizationPercent": float(conn_pct or 0.0),
        "postgresUp": 1,
    }
