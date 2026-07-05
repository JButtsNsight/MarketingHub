-- cdk/sql/enable-pgaudit.sql
-- HIPAA §164.312(b) audit controls (spec §15): attributable DML on PHI tables.
-- Combined with per-user JWTs (spec §12), reads/writes are attributable to a principal.

CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Session-level default: capture DDL and role/privilege changes cluster-wide.
ALTER SYSTEM SET pgaudit.log = 'ddl, role';
ALTER SYSTEM SET pgaudit.log_catalog = off;      -- reduce noise from catalog reads
ALTER SYSTEM SET pgaudit.log_parameter = off;    -- NEVER log parameters (no PHI in logs, spec §15)
ALTER SYSTEM SET pgaudit.log_relation = on;      -- one entry per relation touched
SELECT pg_reload_conf();

-- Object-level audit on the PHI-bearing roles: log all reads AND writes attributed
-- to whichever role executed them (role attribution). Apply per app role that touches PHI.
ALTER ROLE authenticated SET pgaudit.log = 'read, write';
ALTER ROLE service_role  SET pgaudit.log = 'read, write';  -- service_role reads are otherwise anonymous
-- anon should never touch PHI; capture any attempt.
ALTER ROLE anon          SET pgaudit.log = 'read, write';

-- Verify (acceptance §17): a SELECT/INSERT on a PHI table appears in the log with the acting role.
