import type { GuideModule } from "./types";

/**
 * OWNER: overview domain — the Overview dashboard (stat cards, engagement charts, admin cards),
 * Settings (persona/preferences), and the shared Live badge.
 * Ids: `overview.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const overview: GuideModule = {
  // ── Overview page ────────────────────────────────────────────────────────
  "overview.page.header": {
    title: "Project home page",
    body: "Your project's front page: template totals, the last 30 days of campaign engagement, and shortcuts to admin areas. Everything here is read live from the project's database each time the page loads.",
  },
  "overview.stats.templates": {
    title: "Total message templates",
    body: "A template is a saved, reusable message design that campaigns send from. This is how many exist across both kinds — email and text — with the date the newest one was added.",
  },
  "overview.stats.email": {
    title: "Email templates",
    body: "Counts the saved templates that are email designs. If it reads zero, no email campaign can start from a ready-made message yet.",
  },
  "overview.stats.text": {
    title: "Text templates",
    body: "Counts the saved templates that are SMS designs — text messages sent to phones. Text campaigns pick from these when they send.",
  },
  "overview.stats.categories": {
    title: "Template categories",
    body: "Categories are the folder-like labels used to group templates (for example by audience or season). This counts how many distinct labels are in use right now.",
  },
  "overview.engagement.sent": {
    title: "Messages sent (30 days)",
    body: "Every message that left the system in the last 30 days, across all campaigns that sent in that window. A send can still succeed or fail afterwards — see Delivered next door.",
  },
  "overview.engagement.delivered": {
    title: "Confirmed deliveries",
    body: "Messages the phone carriers confirmed reached a handset in the last 30 days. Always at or below Messages sent — some sends fail or never report back.",
  },
  "overview.engagement.clicked": {
    title: "Recipients who clicked",
    body: "How many different people tapped a tracked link in a campaign message over the last 30 days. Only campaigns whose links were tracked can count clicks.",
  },
  "overview.engagement.replies": {
    title: "Replies received",
    body: "Text messages people sent back to your campaigns in the last 30 days. The hint flags replies still waiting for a human in the inbox — those may need an answer.",
  },
  "overview.engagement.opt-outs": {
    title: "People who opted out",
    body: "Recipients who texted STOP after a send in the last 30 days. Each one joins the STOP list and is never texted again — a legal requirement, not a preference.",
  },
  "overview.engagement.stop-list": {
    title: "Do-not-text list size",
    body: "The total count of phone numbers that ever opted out. Every send automatically skips these numbers, so campaigns can never text them again.",
  },
  "overview.recent.table": {
    title: "Latest campaigns",
    body: "Each row is one campaign — a message sent (or scheduled) to a list of recipients — newest first, with its send, delivery, click, reply, and opt-out counts. A dash under clicked means that campaign had no tracked links.",
  },
  "overview.recent.open-campaign": {
    title: "Open this campaign",
    body: "Shows the campaign's full detail page: the exact message, every recipient with their delivery result, replies, and click activity.",
  },
  "overview.explore.auth": {
    title: "Authentication admin",
    body: "Authentication is how people prove who they are before using the app. Opens the admin view of the sign-in system: user accounts, sessions, single sign-on, and impersonation.",
  },
  "overview.explore.advisors": {
    title: "Automated health checks",
    body: "Advisors are automatic scans of the database that flag security gaps and slow queries, each with a suggested fix. Open this to review the current findings.",
  },
  "overview.explore.cloud": {
    title: "Cloud feature status",
    body: "Supabase Cloud is the hosted version of the backend this project runs on. This page lists the platform's features and shows which ones exist in this self-hosted setup.",
  },
  "overview.explore.infrastructure": {
    title: "Servers and services",
    body: "The machinery this project runs on: which backend services are up, the security posture, backups, and monitoring. Start here when something seems down.",
  },
  "overview.storage.open": {
    title: "Open the file browser",
    body: "Storage is the project's private file area (a “bucket”), used here for campaign template assets. Opens the full browser where you can upload, download, move, and delete files.",
  },
  "overview.storage.summary": {
    title: "Bucket contents at a glance",
    body: "A live tally of the folders, files, and total size in the campaign-templates bucket. The counts come from listing the bucket as this page loads.",
  },
  "overview.storage.unavailable": {
    title: "Storage didn't answer",
    body: "The console asked the storage service to list the bucket's files and got no reply, so no counts can be shown. The files themselves are not affected — reload to retry, or check Infrastructure if it persists.",
  },

  // ── Settings page ────────────────────────────────────────────────────────
  "overview.settings.header": {
    title: "Console wiring check",
    body: "A read-only page showing how this console reaches its backend, which integration credentials are present, fixed project facts, and your own account. Nothing here edits data, and secret values are never displayed.",
  },
  "overview.settings.connection": {
    title: "Backend connection",
    body: "Each row is one piece of the console-to-backend wiring — the data API address, region, and required keys — shown as present or not set. “Not set” means whatever needs it is off; the values themselves stay hidden.",
  },
  "overview.settings.persona": {
    title: "Preview persona switch",
    body: "In preview builds sign-in is simulated, and this chip shows which pretend role you are browsing as. The button flips between admin and member and reloads, so you can check what each role can see.",
  },
  "overview.settings.sms-tokens": {
    title: "Texting integration credentials",
    body: "Whether the keys for the texting stack are present: Monday.com (where contact lists live) and SimpleTexting (the service that sends the texts). A “not set” row means that integration cannot run.",
  },
  "overview.settings.worker-token": {
    title: "Verified on the worker",
    body: "The send key lives on the background sender process, not this web app, so this page cannot confirm it exists. Verify it in the worker's log heartbeat or in AWS Secrets Manager instead.",
  },
  "overview.settings.facts": {
    title: "Fixed project facts",
    body: "Where this deployment lives: the AWS account and region, the web address, the Supabase bundle, and the Postgres (database) version. Handy to quote in support or infrastructure requests.",
  },
  "overview.settings.account": {
    title: "Your identity here",
    body: "Who the backend believes you are: your email, name, and groups. Groups are permission labels (like admin) granted at sign-in that decide which sections of this console you can open.",
  },
  "overview.settings.sign-out": {
    title: "Sign out",
    body: "Ends your session in this browser and returns you to the sign-in screen. Nothing on the server changes — your data, campaigns, and settings all stay put.",
  },

  // ── Shared live-view badge (components/live/LiveRefresher) ───────────────
  "overview.live.badge": {
    title: "Live updates active",
    body: "This view is connected to the database's realtime feed: when rows change, the page refreshes itself within a few seconds. If the badge is absent, changes appear only when you reload.",
  },
};
