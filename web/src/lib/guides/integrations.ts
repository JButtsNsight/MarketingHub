import type { GuideModule } from "./types";

/**
 * OWNER: integrations domain — Cron, Queues, Vault, Edge Functions, Realtime, Infrastructure.
 * Ids: `integrations.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const integrations: GuideModule = {
  // ---- shared across the Integrations section ----------------------------
  "integrations.section.tabs": {
    title: "Integrations sections",
    body: "Cron (scheduled jobs), Queues (background work), and Vault (encrypted secrets) all live inside the database itself. These tabs switch between their consoles.",
  },

  // ---- Cron ----------------------------------------------------------------
  "integrations.cron.page": {
    title: "Scheduled database jobs",
    body: "Cron runs SQL commands on a repeating timetable inside the database (the pg_cron extension) — no outside scheduler needed. This page lists every job and its recent run history.",
  },
  "integrations.cron.unavailable": {
    title: "Cron data unavailable",
    body: "The console could not reach the pg_cron job catalog in the database, so nothing can be shown. Usually temporary — refresh in a moment; if it persists the pg_cron extension may not be installed.",
  },
  "integrations.cron.stats": {
    title: "Job and run counts",
    body: "A summary of the jobs below: how many exist, how many are active (will run on schedule), and how many of the shown runs failed. A failed run means the SQL command errored.",
  },
  "integrations.cron.job-name": {
    title: "Job name",
    body: "A label that identifies this job in the list. Names are unique: scheduling with a name that already exists replaces that job instead of adding a second one.",
  },
  "integrations.cron.job-schedule": {
    title: "When it runs",
    body: 'A cron expression: five fields for minute, hour, day, month, and weekday. For example "*/5 * * * *" means every 5 minutes; "0 3 * * *" means daily at 03:00.',
  },
  "integrations.cron.job-command": {
    title: "What it runs",
    body: "The SQL statement the database executes each time the schedule fires — refresh a view, queue a message, clean up rows. It runs inside the database; no browser involved.",
  },
  "integrations.cron.schedule-job": {
    title: "Create the schedule",
    body: "Saves the job so the database starts running the command on this timetable. If a job with this name already exists, it is replaced — you are asked to confirm first.",
  },
  "integrations.cron.jobs-table": {
    title: "All scheduled jobs",
    body: "Every job the database scheduler knows about: its timetable, the command it runs, and whether it is active (paused jobs stay listed but do not run).",
  },
  "integrations.cron.job-runs": {
    title: "Show this job's runs",
    body: "Filters the run history below to just this job, so you can check whether it is succeeding and what it last reported.",
  },
  "integrations.cron.unschedule": {
    title: "Stop and remove job",
    body: "Deletes this job's schedule: it stops running immediately and disappears from the list. Past run history stays, but bringing the job back means re-creating it from scratch.",
  },
  "integrations.cron.runs-table": {
    title: "Recent run history",
    body: "Each row is one execution of a job: when it started and ended, whether it succeeded or failed, and the message the database returned. Newest runs are the place to spot failures.",
  },
  "integrations.cron.show-all-runs": {
    title: "Widen to all jobs",
    body: "The run history is currently filtered to one job. This clears the filter so runs from every job show again.",
  },

  // ---- Queues ---------------------------------------------------------------
  "integrations.queues.page": {
    title: "Background work lists",
    body: "A queue is a waiting list of messages stored in the database (the pgmq extension): one part of the system adds work, another picks it up later. This page shows every queue and its messages.",
  },
  "integrations.queues.unavailable": {
    title: "Queue data unavailable",
    body: "The console could not read the pgmq queue catalog from the database, so nothing can be shown. Usually temporary — refresh in a moment; if it persists the pgmq extension may not be installed.",
  },
  "integrations.queues.stats": {
    title: "Queue totals",
    body: "Totals across every queue: pending messages are waiting to be processed; archived messages were handled and moved to an archive table for record keeping.",
  },
  "integrations.queues.table": {
    title: "All queues",
    body: "Each row is one queue: how many messages are waiting, how many it has ever carried, and the age of its oldest waiting message. A very old oldest message usually means nothing is consuming the queue.",
  },
  "integrations.queues.select-queue": {
    title: "Open this queue",
    body: "Shows this queue's messages below — the live waiting list and its archive. Opening is read-only: nothing is consumed by looking.",
  },
  "integrations.queues.send-toggle": {
    title: "Write a test message",
    body: "Opens a small panel to add a message to this queue by hand — useful for testing whatever consumes it. Adding a message never removes or changes existing ones.",
  },
  "integrations.queues.pop-next": {
    title: "Consume the next message",
    body: "Pops the queue: reads AND permanently removes the next waiting message, exactly as a real consumer would. The message is gone afterwards — this cannot be undone.",
  },
  "integrations.queues.refresh": {
    title: "Reload queue data",
    body: "Re-reads the queue list and the open queue's messages from the database, so the view reflects what is there right now.",
  },
  "integrations.queues.send-json": {
    title: "Message body (JSON)",
    body: 'The content of the test message, written as JSON — a simple text format like {"hello": "world"}. Whatever consumes the queue will receive exactly this.',
  },
  "integrations.queues.send-message": {
    title: "Add to the queue",
    body: "Puts the JSON above at the end of this queue as a new waiting message. It stays there until something consumes, archives, or deletes it.",
  },
  "integrations.queues.live-table": {
    title: "Waiting messages",
    body: "Messages currently in the queue, shown by peeking at the underlying table — looking here never consumes a message or disturbs real consumers. \"reads\" counts how many times a consumer has picked one up.",
  },
  "integrations.queues.archive-message": {
    title: "Archive this message",
    body: "Moves the message out of the live queue into the queue's archive table — consumers will no longer see it, but the content is kept for record keeping.",
  },
  "integrations.queues.delete-message": {
    title: "Delete this message",
    body: "Permanently removes the message from the queue. Nothing is archived — the content is destroyed and cannot be recovered.",
  },
  "integrations.queues.archived-table": {
    title: "Archived messages",
    body: "Messages that were moved out of the live queue after being handled (or archived by hand). They are kept for reference and never delivered to consumers again.",
  },

  // ---- Vault ----------------------------------------------------------------
  "integrations.vault.page": {
    title: "Encrypted secrets store",
    body: "Vault keeps sensitive values — API keys, passwords — encrypted inside the database so other database code can use them without storing plain text. This page manages those secrets.",
  },
  "integrations.vault.unreachable": {
    title: "Vault unreachable",
    body: "The console could not read the vault's metadata from the database, so no secrets can be listed. Usually temporary — refresh; if it persists the supabase_vault extension may not be installed.",
  },
  "integrations.vault.new-secret": {
    title: "Store a new secret",
    body: "Opens a form to add a secret. The value is encrypted the moment it is saved and never shown in this list — reading it back requires an audited per-secret reveal.",
  },
  "integrations.vault.table": {
    title: "Stored secrets",
    body: "Each row is one encrypted secret: its name, description, and timestamps — metadata only. Values stay masked until you explicitly reveal one, and every reveal is recorded.",
  },
  "integrations.vault.reveal": {
    title: "Show the secret value",
    body: "Decrypts this one secret and shows it on screen until you hide it (it auto-masks after 30 seconds). The reveal is written to an audit log with your identity first — no anonymous peeking.",
  },
  "integrations.vault.hide": {
    title: "Mask the value again",
    body: "Puts the mask back over the revealed value right away. It also disappears on its own after 30 seconds, but hide it as soon as you are done reading.",
  },
  "integrations.vault.edit": {
    title: "Replace this secret",
    body: "Opens the edit form. The current value is never shown there — saving encrypts what you type and replaces the stored value, so use this to rotate a key or fix the description.",
  },
  "integrations.vault.delete": {
    title: "Destroy this secret",
    body: "Permanently deletes the secret; the encrypted value is unrecoverable once gone. You must type the secret's exact name to confirm — this cannot be undone.",
  },
  "integrations.vault.confirm-name": {
    title: "Type name to confirm",
    body: "A safety check for a destructive action: the delete only proceeds if what you type exactly matches this secret's name, so a mis-click can never destroy the wrong one.",
  },
  "integrations.vault.field-name": {
    title: "Secret name",
    body: "The handle other code uses to look this secret up — unique across the vault. Pick something descriptive, like the service the key belongs to.",
  },
  "integrations.vault.field-description": {
    title: "What it's for",
    body: "An optional plain-text note shown in the secret list — the only context teammates get, since values themselves stay hidden.",
  },
  "integrations.vault.field-value": {
    title: "The secret itself",
    body: "The sensitive value to protect. It is masked while you type, encrypted when saved, and shown again only through an audited reveal. When editing, typing here replaces the old value.",
  },
  "integrations.vault.save": {
    title: "Encrypt and save",
    body: "Encrypts the value and stores the secret. When editing, this permanently replaces the previous value — there is no history to roll back to.",
  },

  // ---- Edge Functions ---------------------------------------------------------
  "integrations.functions.page": {
    title: "Small server programs",
    body: "Edge Functions are small pieces of server code that run on request — for jobs a plain database query can't do, like calling outside services. This page lists them and lets you test-run one.",
  },
  "integrations.functions.table": {
    title: "Registered functions",
    body: 'Each row is one function known to this deployment: its version, when its code last changed, and when it was last deployed. "Not deployed" means the code is registered but not yet running on the host.',
  },
  "integrations.functions.source": {
    title: "View the code",
    body: "Shows this function's source code read-only, straight from the registry — handy for understanding what a function actually does before invoking it.",
  },
  "integrations.functions.pick-invoke": {
    title: "Target the tester",
    body: "Selects this function in the invoke tester below so you can send it a request and inspect the response.",
  },
  "integrations.functions.target": {
    title: "Function to run",
    body: "Picks which function receives the test request. Only functions in the registry can be invoked.",
  },
  "integrations.functions.method": {
    title: "Request method",
    body: "How the test request is sent: POST carries a JSON body to the function; GET just calls it with no body. Most functions expect POST.",
  },
  "integrations.functions.body": {
    title: "Request body (JSON)",
    body: "The data sent to the function, written as JSON. It is checked before anything is sent — a typo here blocks the request rather than shipping garbage.",
  },
  "integrations.functions.send-request": {
    title: "Run the function",
    body: "Actually executes the function on the server with the chosen method and body, then shows the status, timing, and response below. Whatever the function does — writes included — really happens.",
  },
  "integrations.functions.logs-note": {
    title: "Logs not available here",
    body: "Function logs currently exist only as container output on the server, so this console cannot show them yet. Nothing is broken — the viewer just isn't built.",
  },

  // ---- Realtime ---------------------------------------------------------------
  "integrations.realtime.page": {
    title: "Live data inspector",
    body: "Realtime pushes changes to browsers instantly over an open connection instead of waiting for a page refresh. This console joins those channels to watch, test, and debug the traffic.",
  },
  "integrations.realtime.unreachable": {
    title: "Realtime not reachable",
    body: "The realtime service did not answer, so channels cannot be joined from here. The load-balancer route and settings it needs have not been applied to this deployment yet.",
  },
  "integrations.realtime.connection": {
    title: "Connection health",
    body: "Live status of the link to the realtime service: the socket (the open connection), the token (short-lived proof of who you are), and the heartbeat (a ping every 25s proving the line is alive).",
  },
  "integrations.realtime.topic": {
    title: "Channel to join",
    body: "A channel is a named room that live messages flow through; its topic is the room's name. Channels here must start with mh: — anything else is refused by the security policies.",
  },
  "integrations.realtime.events": {
    title: "Events to listen for",
    body: "Only broadcasts whose event name is in this comma-separated list will show in the feed. An event name is just a label senders put on each message.",
  },
  "integrations.realtime.private": {
    title: "Private channels only",
    body: "Locked on: every channel here requires a signed-in identity, and the database policies decide who may join. Public, unauthenticated channels are deliberately not allowed.",
  },
  "integrations.realtime.topic-warning": {
    title: "This join will fail",
    body: "Warning shown for topics outside mh: — the security policies only allow this console's own namespace, so the realtime service will refuse the join.",
  },
  "integrations.realtime.join": {
    title: "Open the channel",
    body: "Connects to the topic above and starts streaming its events into the feed. Joining is read-only listening — nothing is sent to other subscribers.",
  },
  "integrations.realtime.leave": {
    title: "Disconnect the channel",
    body: "Closes the current channel: the feed stops receiving, and your presence entry (if tracked) disappears for everyone else.",
  },
  "integrations.realtime.send-event": {
    title: "Event name to send",
    body: "The label attached to the test broadcast. Subscribers filter by these names, so only listeners watching this event will see the message.",
  },
  "integrations.realtime.send-payload": {
    title: "Broadcast payload (JSON)",
    body: "The content of the test broadcast, as a JSON object. Every subscriber on the channel receives exactly this.",
  },
  "integrations.realtime.send": {
    title: "Broadcast to everyone",
    body: "Publishes the event and payload to every subscriber currently on this channel — a real message, not a simulation. The first send each session asks for confirmation.",
  },
  "integrations.realtime.track": {
    title: "Announce your presence",
    body: "Presence is a live who's-here list every subscriber can see. Track adds you (your email and join time) to that list on this channel.",
  },
  "integrations.realtime.untrack": {
    title: "Withdraw your presence",
    body: "Removes you from the channel's who's-here list. Other subscribers see you disappear immediately; you keep receiving events either way.",
  },
  "integrations.realtime.feed": {
    title: "Live message feed",
    body: "Every event this inspector has seen since joining, newest first: broadcasts, presence changes, connection status, and your own sends. Capped at 200 — it is a window, not a log store.",
  },
  "integrations.realtime.clear": {
    title: "Empty the feed",
    body: "Clears the captured messages from this screen only. Nothing is deleted anywhere else — the feed was never stored beyond this page.",
  },
  "integrations.realtime.payload-viewer": {
    title: "Full payload view",
    body: "Shows the complete content of the selected feed row (or the newest message) formatted for reading, since table cells truncate long payloads.",
  },

  // ---- Infrastructure -----------------------------------------------------------
  "integrations.infrastructure.page": {
    title: "How this system runs",
    body: "A reference map of the deployment itself: the services that make up the platform, where files live, and how security, backups, and networking are set up. Read-only — nothing here changes anything.",
  },
  "integrations.infrastructure.reference-note": {
    title: "Hand-maintained reference",
    body: "This page is curated documentation, not a live probe of the infrastructure — it describes the intended setup and can lag reality after changes.",
  },
  "integrations.infrastructure.services": {
    title: "Running services",
    body: "Each row is one program that makes up the platform — the database, its APIs, this console — with the port it listens on and whether it is reachable from outside.",
  },
  "integrations.infrastructure.buckets": {
    title: "File storage buckets",
    body: "Buckets are named folders for uploaded files. Each row shows one bucket, what kind of files it holds, and whether its contents are publicly readable or private.",
  },
  "integrations.infrastructure.security": {
    title: "Security posture",
    body: "The security measures in place across the deployment — encryption, access rules, audit trails — each with a short note on how it is enforced.",
  },
  "integrations.infrastructure.backups": {
    title: "Backups and recovery",
    body: "How the data survives a disaster: what gets backed up, how often, where copies live, and how the system would be restored.",
  },
  "integrations.infrastructure.observability": {
    title: "Monitoring and logs",
    body: "Where to look when something misbehaves: the metrics, logs, and alerts that watch this deployment and where each of them lives.",
  },
  "integrations.infrastructure.network": {
    title: "Network topology",
    body: "How traffic flows: which pieces are reachable from the internet, which are internal-only, and what sits in between (load balancers, private networks).",
  },
};
