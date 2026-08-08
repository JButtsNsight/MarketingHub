# Wave-6 analytics headroom watch (Supabase host)

_Runbook ONLY — this document changes no infrastructure. Created 2026-08-08
with the Wave-6 Logs & Reports enablement (deploy runbook §11)._

## Why this exists

The Supabase host is a **single m6i.xlarge** (4 vCPU / 16 GiB) running the
entire pinned bundle. The Logflare `analytics` + `vector` containers were
already running before Wave 6, but nothing ever *queried* them. Wave 6 makes
them load-bearing in two new ways:

1. **Interactive query load** — every `/logs` and `/reports` page view (and
   the Explorer's optional 10s Tail polling) sends Logflare endpoint queries
   through Kong. Logflare translates them to SQL against its **Postgres
   backend** — i.e. the *same* Postgres instance that serves the app
   (database `_supabase`, schema `_analytics`). Upstream documents this
   backend as dev-focused, not production-optimized.
2. **Ingest growth** — vector ships 7 services' container logs into
   `_analytics` tables continuously. Query load now competes with that
   ingest AND with the app's own PostgREST traffic on the same box.

Expected steady-state impact is small (a handful of marketing users, canned
templates, LIMIT-clamped), but this is the first wave that can turn a
console page view into arbitrary-sized Postgres scans on the shared host —
so it gets a standing watch.

## What to watch

All of it is in CloudWatch (namespace `CWAgent` / `AWS/EC2` +
`ECS/ContainerInsights`-style agent metrics and `/nsight-supabase/*` log
groups) — CloudWatch remains the infra log/metric source of truth.

| Signal | Where | Healthy | Investigate when |
|---|---|---|---|
| Host CPU | `AWS/EC2` CPUUtilization + CWAgent per-process | < 60% sustained | > 80% for 15 min, or spikes correlating with `/reports` traffic |
| Host memory | CWAgent `mem_used_percent` | < 75% | > 85% (Logflare is a BEAM VM — its baseline is fine, growth is not) |
| `supabase-analytics` container health | `docker ps` health / CWAgent `UnhealthyContainerCount` | healthy, 0 unhealthy | any unhealthy period — Logflare down flips the consoles to "Analytics unavailable" (honest, not an outage) |
| `supabase-kong` container health | same | healthy, StartedAt stable | restarts after the W6 enable = suspect the kong-nsight.yml mount |
| Kong 5xx on `/analytics/*` | Kong access logs (stdout → CloudWatch via the agent) | ~0 | sustained 502/503/504 = analytics container wedged or slow (Kong upstream timeout is 60s; the app client gives up at 30s) |
| App `[console:logs]` errors | app logs; `/api/console/logs` + `/api/console/reports` 400/500 rates | rare 400s (user typos) | a 400/500 *spike* = template/translator drift or analytics degradation |
| `_analytics` Postgres load | `pg_stat_activity` (console SQL editor or `docker exec supabase-db psql`) filtered `datname='_supabase'` | short-lived queries | long-running (>30s) `_analytics` queries piling up — they outlive the app's 30s abort and keep burning the shared DB |
| `_supabase` DB size growth | `pg_database_size('_supabase')` trend | slow, linear | step change after W6 — nothing about Wave 6 raises ingest, so a jump means log volume itself jumped |

Quick host-side spot-check (SSM session):

```bash
cd /opt/supabase
docker stats --no-stream supabase-analytics supabase-kong supabase-db
docker exec supabase-db psql -U supabase_admin -d _supabase -tAc \
  "select count(*), coalesce(max(extract(epoch from now()-query_start))::int,0) as oldest_s
     from pg_stat_activity where datname='_supabase' and state <> 'idle'"
```

## Load characteristics that keep this bounded (by design)

- Every app query is a fixed template: LIMIT clamped (logs ≤ 1000, top
  routes ≤ 100), time-windowed via `iso_timestamp_start/end`, no user SQL.
- The app aborts at 30s; Tail polling is opt-in, 10s interval, and pauses on
  hidden tabs.
- The route exposes only `/api/endpoints/query/*` — the read-only query
  surface. Logflare's endpoint MANAGEMENT resources (create/update/delete,
  which honor the same private token) live directly under `/api/endpoints`
  and are deliberately NOT routed, and neither is the wider management API
  (`/api/backends`, `/api/rules`) or the Logflare UI.

## Contingencies (in escalation order — none are actions for this wave)

1. **Behavioral:** discourage 7d-range Explorer queries; the presets make
   1h/24h the default paths.
2. **Retention:** `_analytics` tables grow forever by default self-hosted;
   a future wave should add a retention job (delete/partition-drop old
   `log_events_*` rows) if `_supabase` size trends up.
3. **Resize:** the real lever is the instance type in
   `cdk/lib/compute-stack.ts` (`InstanceClass.M6I, InstanceSize.XLARGE` →
   `XLARGE2`). That is a **future-wave cdk change + host replacement** (the
   data volume + first-boot persistence make replacement safe); do NOT
   hand-resize the live instance outside cdk.
4. **Kill switch:** rolling back the W6 route (deploy runbook §11.4) removes
   ALL app-driven query load in one step; the consoles degrade honestly.
