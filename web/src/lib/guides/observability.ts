import type { GuideModule } from "./types";

/**
 * OWNER: observability domain — Logs, log drains, Reports, Backups.
 * Ids: `observability.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const observability: GuideModule = {
  // ── Logs ────────────────────────────────────────────────────────────────
  "observability.logs.page": {
    title: "Service logs",
    body: "Every service behind this app — the API gateway, database, sign-in system — keeps a diary of what it did. This page reads those diaries so you can answer what happened and when.",
  },
  "observability.logs.tabs": {
    title: "Logs pages",
    body: "Switches between the log views: Logs (read and search recent entries) and Drains (where copies of logs could be shipped outside this system).",
  },
  "observability.logs.source": {
    title: "Which service's logs",
    body: "Picks the service whose log you are reading — for example the API gateway (every incoming request) or Postgres, the database itself. Each service keeps a separate log.",
  },
  "observability.logs.range-preset": {
    title: "Time window",
    body: "How far back to look, ending now. Shorter windows answer faster; pick 7d when you are hunting something that happened days ago.",
  },
  "observability.logs.tail": {
    title: "Follow new entries",
    body: "While on, the table re-queries every 10 seconds so fresh entries keep appearing — useful when watching an incident live. It pauses while this browser tab is hidden.",
  },
  "observability.logs.refresh": {
    title: "Re-run the query",
    body: "Fetches the latest entries for the current service, time window, and filters. Reading logs never changes anything.",
  },
  "observability.logs.severity-filter": {
    title: "Severity filter",
    body: "Each log entry has a severity — how serious it is, from routine info up to error. Turn pills on to show only those levels; none selected means show everything.",
  },
  "observability.logs.search": {
    title: "Search log messages",
    body: "Finds entries whose message contains this exact text. It is matched as plain text, never run as code, so pasting anything here is safe.",
  },
  "observability.logs.search-submit": {
    title: "Run the search",
    body: "Nothing is filtered while you type — the query runs only when you press this (or Enter in the box).",
  },
  "observability.logs.table": {
    title: "Log entries",
    body: "Each row is one event a service recorded: when it happened, its severity, and the message. Press a row's + to see the full technical detail behind it.",
  },
  "observability.logs.expand-row": {
    title: "Full entry detail",
    body: "Opens everything the service recorded about this event — the structured metadata behind the one-line message. Useful when the summary is not enough.",
  },
  "observability.logs.query-error": {
    title: "Query failed",
    body: "The last log query did not succeed; this is the reason. Any rows below are from the previous successful query, not this one.",
  },
  "observability.logs.unavailable": {
    title: "Log store unreachable",
    body: "Logs live in a separate analytics service (Logflare) that did not answer. Nothing is lost or broken elsewhere — this page just cannot read logs until an operator enables the connection.",
  },

  // ── Log drains ──────────────────────────────────────────────────────────
  "observability.drains.page": {
    title: "Log drains",
    body: "A log drain continuously copies your logs to an outside system (like Datadog or S3) for alerting or long-term keeping. This page explains why drains are deliberately off here and what covers that job instead.",
  },
  "observability.drains.capability": {
    title: "Why drains are off",
    body: "Drains exist upstream but are switched off here on purpose: creating one would let the log system write and send data outside, and this console keeps logs strictly read-only.",
  },
  "observability.drains.coverage": {
    title: "What covers the job",
    body: "The delivery and alerting a drain would provide already exist: an in-stack pipeline feeds the Logs and Reports pages, and CloudWatch (AWS's monitoring service) handles off-host alarms.",
  },
  "observability.drains.pipeline-table": {
    title: "Log routing map",
    body: "Each row is one service whose container output is shipped into the log store: the container name, the stream it lands in, and the source name you pick on the Logs page.",
  },

  // ── Reports ─────────────────────────────────────────────────────────────
  "observability.reports.page": {
    title: "Usage and health charts",
    body: "Charts computed from the service logs: how much traffic the system handles, how often requests fail, and sign-in activity. Read-only — a place to spot trends and trouble.",
  },
  "observability.reports.range-preset": {
    title: "Time window",
    body: "How far back the charts look, ending now. 1h plots per minute, 24h per hour, 7d per day.",
  },
  "observability.reports.refresh": {
    title: "Recompute the charts",
    body: "Re-runs every chart's query over the selected window so the figures include the latest activity. Nothing is changed by refreshing.",
  },
  "observability.reports.stat-requests": {
    title: "Total API requests",
    body: "How many requests reached the system in the selected window, counted at the front door (the gateway every request passes through).",
  },
  "observability.reports.stat-error-rate": {
    title: "Share of failed requests",
    body: "The percentage of requests answered with an error status. A rising number means users are hitting problems — check the error chart and Logs to see which requests.",
  },
  "observability.reports.stat-auth-events": {
    title: "Sign-in activity",
    body: "How many events the authentication service (the part that handles sign-ins and sessions) logged in the window — a rough pulse of login activity.",
  },
  "observability.reports.stat-service-lines": {
    title: "Service log volume",
    body: "How many log lines the realtime and file-storage services wrote in the window. A sudden jump often means one of them is retrying or erroring.",
  },
  "observability.reports.chart-requests": {
    title: "Traffic over time",
    body: "Requests reaching the system per time bucket. Flat lines are normal; cliffs or spikes tell you exactly when load changed.",
  },
  "observability.reports.chart-errors": {
    title: "Error rate over time",
    body: "The share of requests that failed, per time bucket. Spikes show exactly when problems started — line the time up against Logs to find the cause.",
  },
  "observability.reports.chart-auth": {
    title: "Sign-in events over time",
    body: "Events logged by the authentication service per time bucket — sign-ins, token refreshes, and their errors, all levels combined.",
  },
  "observability.reports.chart-services": {
    title: "Realtime and Storage volume",
    body: "Log lines from the realtime (live updates) and storage (file hosting) services per time bucket. Chatter here rises with their usage.",
  },
  "observability.reports.top-routes": {
    title: "Busiest endpoints",
    body: "Each row is one API endpoint (a method plus a path) ranked by how many requests it received in the window — where your traffic actually goes.",
  },
  "observability.reports.panel-error": {
    title: "This query failed",
    body: "Only this panel's query failed; the reason is shown and the other panels still show real data. Refresh to try again.",
  },
  "observability.reports.unavailable": {
    title: "Analytics unreachable",
    body: "The charts are computed by a separate analytics service (Logflare) that did not answer. Nothing else in the console is affected — reports return once an operator restores the connection.",
  },

  // ── Backups ─────────────────────────────────────────────────────────────
  "observability.backups.page": {
    title: "Database backups",
    body: "A backup is a saved copy of the whole database you can restore if data is lost or damaged. This page reports the copies that exist — it can only watch; backups and restores run on the server itself.",
  },
  "observability.backups.tabs": {
    title: "Database pages",
    body: "Switches between the pages of the Database section — different views of the same database. Backups lives here because a backup is a copy of that database.",
  },
  "observability.backups.unreachable": {
    title: "No backup report",
    body: "This page reads a status report a job on the database server writes every 15 minutes. No report exists to read, so nothing can be shown about backups until an operator installs the reporter.",
  },
  "observability.backups.unreadable": {
    title: "Report not parseable",
    body: "A status report exists but its contents could not be understood, so backup details cannot be shown. An operator should inspect the reporter job on the database host.",
  },
  "observability.backups.reported-at": {
    title: "When status was captured",
    body: "Everything below reflects the moment the database server last wrote its status report — not this second. The reporter runs every 15 minutes.",
  },
  "observability.backups.stale": {
    title: "Report is overdue",
    body: "The status report is older than expected, so the reporter job may have stopped. The details below may be out of date until it reports again.",
  },
  "observability.backups.refresh": {
    title: "Re-read backup status",
    body: "Fetches the newest status report and archiving check. It only reads — it can never start a backup or a restore.",
  },
  "observability.backups.refresh-error": {
    title: "Refresh failed",
    body: "The status re-read did not succeed; this is the reason. The details shown are from the last successful read.",
  },
  "observability.backups.stanza-status": {
    title: "Backup system health",
    body: "The backup tool's own verdict on its setup (a stanza is its name for one database's backup configuration). Anything but ok means new backups may be failing.",
  },
  "observability.backups.lock-badge": {
    title: "Backup running now",
    body: "The backup tool is holding its lock, which means a backup is being taken right now. Normal — sizes and the list update when it finishes.",
  },
  "observability.backups.stat-retained": {
    title: "Copies kept",
    body: "How many restorable backup sets exist right now. Full = a complete copy; diff and incr = only what changed since an earlier set, so they are smaller but need their parent to restore.",
  },
  "observability.backups.stat-db-size": {
    title: "Database size",
    body: "How big the database was when the newest backup ran — roughly what a restore would bring back.",
  },
  "observability.backups.stat-repo-size": {
    title: "Backup storage used",
    body: "The compressed size of the newest backup set on disk — usually much smaller than the database itself.",
  },
  "observability.backups.schedule": {
    title: "When backups run",
    body: "The fixed timetable the server follows and how many past sets it keeps. Older sets beyond the retention counts are pruned automatically.",
  },
  "observability.backups.table": {
    title: "Backup sets",
    body: "Each row is one restorable point in time: when it finished, its type, its size, and whether its integrity check passed. Newest first; restores run from the server runbook, never from here.",
  },
  "observability.backups.set-type": {
    title: "Full, diff, or incr",
    body: "Full is a complete copy of the database. Diff and incr store only changes since an earlier set — smaller and faster, but restoring them also needs their parent full backup.",
  },
  "observability.backups.checksum": {
    title: "Integrity check",
    body: "Every backed-up page is checksummed to prove the copy is not corrupted. Clean means it verified; error means this set may not restore correctly — treat it as unsafe.",
  },
  "observability.backups.pitr": {
    title: "Restore window",
    body: "Point-in-time recovery: with a backup plus the change journal (WAL), the database can be rewound to any moment between these two timestamps — not just to backup times.",
  },
  "observability.backups.wal-unverified": {
    title: "Change journal unverified",
    body: "The database could not confirm when it last archived its change journal (WAL), so the newest restorable moment cannot be proven. Recent changes might not be recoverable yet.",
  },
  "observability.backups.restore-drill": {
    title: "How restores happen",
    body: "Restores are an operator task run on the server from this runbook — this console can never trigger one. The targets: lose at most 5 minutes of data, be back within 2 hours.",
  },
};
