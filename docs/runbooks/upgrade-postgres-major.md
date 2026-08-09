# Runbook: Major PostgreSQL Version Upgrade (spec §3, §22)

**Scope:** MAJOR version bumps (e.g. PG15→17). Minor/patch bumps are a separate, simpler
"pull pinned digest → `up -d`" path (spec §22) — NOT this runbook. Major bumps change the
on-disk format and require a scripted migration + planned downtime.

**Pin PG17 from day one** to avoid an immediate forced migration.

## Pre-upgrade (do NOT skip)
1. **Mandatory verified backup first (spec §9):** take a fresh pgBackRest base backup AND a
   `pg_dumpall`; run the **restore drill** (`restore-drill.md`) against the backup and confirm
   it restores clean. Do not proceed on an unverified backup.
2. **Enumerate extensions and versions:** `SELECT * FROM pg_extension;`. Check for extensions
   that may be dropped/incompatible on the target major (e.g. timescaledb, plv8) — plan their
   handling BEFORE the window.
3. **Announce a planned maintenance window** (single node → Studio 5xx during recreate).

## Upgrade
4. **Quiesce and drop active replication slots** (Realtime): `SELECT pg_drop_replication_slot(slot_name)
   FROM pg_replication_slots;` — a retained replication slot blocks the upgrade and is the
   disk-fill footgun (monitored by the slot-lag alarm, Task 4). Stop the Realtime/logical
   consumers first.
5. **Scripted `pg_upgrade`** into a NEW data directory (or `pg_dump`/restore for the portable
   path). Keep the OLD data directory intact as the rollback artifact — do not delete it.
6. **Reconcile extensions + UID ownership** on the new cluster: re-`CREATE EXTENSION`/`ALTER
   EXTENSION ... UPDATE` to match the target image's bundled versions; fix file/UID ownership.
7. **Re-run the deploy gates:** `enable-pgaudit.sql`, `lockdown-pg-net.sql`, and the RLS gate
   (`rls-gate.sh` must exit 0) against the upgraded cluster before reopening traffic. The
   Wave-8-scoped gate allowlists only documented bundle-managed internals (`cdk/sql/rls-gate.sql`
   header) — after a major upgrade re-check that list against the bundle's new service
   migrations before trusting a pass; app schemas and `storage.objects`/`buckets` are never
   allowlisted.

## Post-upgrade / rollback
8. **Verify:** healthchecks green, REST/Auth/Realtime/Storage/pgvector smoke pass (spec §17),
   `ANALYZE` the database.
9. **Rollback path:** if verification fails, stop the new cluster, point the compose `db` volume
   back at the retained OLD data directory, restart on the prior pinned image digest, and reopen.
10. Only after a clean verification + a following successful nightly backup, retire the OLD data dir.
