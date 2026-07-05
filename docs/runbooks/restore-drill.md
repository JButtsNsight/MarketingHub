# Runbook: Quarterly Restore Drill (spec §9, §17)

**Purpose:** Prove the latest backup is restorable end-to-end. A recovery point that has
never been restored is not a backup. Schedule: **quarterly**, tracked as a recurring ticket.

**Objectives:** RPO ≤ 5 min (WAL archiving), **RTO target < 2 h** for a full rebuild. This
drill records the **measured RTO** each run.

## Preconditions
- On-call has console + SSM access to account 439024109088 / us-east-1.
- The pgBackRest S3 backup bucket and the AWS Backup vault (Vault Lock COMPLIANCE) are healthy.
- A throwaway restore VPC subnet exists (Phase 1 provisions a private subnet in the second AZ).

## Procedure (record start time = T0)
1. **Provision a fresh instance** in the restore subnet from the same launch template
   (IMDSv2 hop-limit 1). Attach a new encrypted data volume (data CMK).
2. **Restore the latest backup:**
   - Primary path — pgBackRest PITR: `pgbackrest --stanza=supabase --type=time \
     "--target=<latest>" restore` into the new PGDATA, or
   - Portable path — `pg_restore`/`psql` from the nightly `pg_dumpall`.
3. **Start Postgres** and confirm **clean WAL replay** — check the log for
   `database system is ready to accept connections` with no `PANIC`/`FATAL`, and
   `SELECT pg_last_wal_replay_lsn();` advances to the archived tip.
4. **Validate row counts / schema:** run `\dt+` per PHI schema and compare
   `SELECT count(*)` (row count) on the top PHI tables against the production baseline
   recorded in the ticket. Zero unexpected deltas.
5. **Storage object round-trip:** using ONLY the bucket-scoped Storage credential
   (spec §10), upload a test object via the restored Storage API, read it back,
   and confirm the Postgres `storage.objects` metadata row matches (dual-store
   consistency, spec §10).
6. **Run the RLS gate** against the restored DB (`cdk/scripts/rls-gate.sh`) — must
   exit 0 (RLS survived the restore).
7. **Record measured RTO** = (time Postgres accepted connections + validation done) − T0.
   File the number in the drill ticket; if > 2 h, open a follow-up to shorten the path
   (e.g. enable Fast Snapshot Restore, spec §9).

## Teardown
- Terminate the drill instance; delete the throwaway data volume (NOT the backups).

## Backup-failure alarm check (spec §17)
- **AWS Backup (secondary tier):** induce a controlled AWS Backup job failure (e.g.
  temporarily deny the backup role `backup:StartBackupJob` or point a plan at a
  non-existent resource), confirm the **`supabase-backup-job-failed` EventBridge rule**
  fires and on-call receives the SNS email, then revert. See Task 11.
- **pgBackRest (primary, minute-RPO tier):** pgBackRest failures emit NO AWS Backup
  event. The host cron (`cdk/assets/pgbackrest-cron`) publishes the
  `Supabase/Backup` / `PgBackRestJobFailed` CloudWatch metric (1 on failure, 0 on
  success); the **`supabase-pgbackrest-job-failed`** alarm pages on-call. Verify by
  running the cron against an intentionally broken stanza (e.g. wrong `BACKUP_BUCKET`)
  and confirming the metric goes to 1 and the alarm fires, then revert.
