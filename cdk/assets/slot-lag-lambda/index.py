"""Publishes the max retained-WAL bytes across all Postgres replication slots
as a CloudWatch custom metric. Fails LOUD: any connection/query error raises,
so the Lambda errors metric (alarmed separately or via the schedule) surfaces it.
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
    _cw.put_metric_data(
        Namespace=NAMESPACE,
        MetricData=[
            {
                "MetricName": METRIC,
                "Value": float(max_bytes),
                "Unit": "Bytes",
            }
        ],
    )
    return {"maxRetainedBytes": int(max_bytes)}
