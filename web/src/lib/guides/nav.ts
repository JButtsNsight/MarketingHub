import type { GuideModule } from "./types";

/**
 * OWNER: shell/nav domain — the masthead, the nav rail's groups + items, and
 * the login/logout chrome. Ids: `nav.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const nav: GuideModule = {
  "nav.shell.guided-toggle": {
    title: "Guided mode",
    body: "Turns these explanations on and off. While on, rest your pointer on any control to learn what it does — nothing is changed by just looking.",
  },
  "nav.shell.theme-toggle": {
    title: "Light or dark look",
    body: "Switches the console between the light (warm sand) and dark (inky navy) looks. Purely visual — it never affects your data, and it remembers your choice on this browser.",
  },
  "nav.shell.wordmark": {
    title: "Back to Overview",
    body: "Takes you to the Overview page — the console's home screen with the health of the whole system at a glance.",
  },

  // ── Nav rail: group labels ────────────────────────────────────────────────
  "nav.rail.group-platform": {
    title: "Platform tools",
    body: "The core database toolkit, arranged like Supabase Studio: data tables, a SQL editor, file storage, server functions, live updates, and API docs. Click the header to collapse or expand the group — the rail remembers your layout.",
  },
  "nav.rail.group-integrations": {
    title: "Database add-ons",
    body: "Optional Postgres add-ons, each with its own screen: scheduled jobs (Cron), background work lists (Queues), and encrypted secrets (Vault). Click the header to collapse or expand the group — the rail remembers your layout.",
  },
  "nav.rail.group-marketing": {
    title: "Marketing tools",
    body: "The messaging product on this platform: templates, SMS campaigns, replies, stuck sends, opt-outs, and results. Click the header to collapse or expand the group — the rail remembers your layout.",
  },
  "nav.rail.group-admin": {
    title: "Admin area",
    body: "Administrator-only screens for running the console itself: sign-in setup, user access, automated checkups, logs, and infrastructure. Click the header to collapse or expand the group — the rail remembers your layout.",
  },
  "nav.rail.group-project": {
    title: "Project",
    body: "Settings that apply to the whole project rather than any single tool. Click the header to collapse or expand the group — the rail remembers your layout.",
  },

  // ── Nav rail: items ───────────────────────────────────────────────────────
  "nav.rail.overview": {
    title: "Overview",
    body: "The console's home screen: system health, recent activity, and shortcuts into each area — a quick read before you dig into a specific tool.",
  },
  "nav.rail.table-editor": {
    title: "Table Editor",
    body: "A table is a spreadsheet-like grid where the database keeps records. Browse and edit rows here directly — no code needed.",
  },
  "nav.rail.sql-editor": {
    title: "SQL Editor",
    body: "SQL is the language for asking a database questions. Write and run queries here when the point-and-click screens can't answer what you need.",
  },
  "nav.rail.database": {
    title: "Database section",
    body: "The database's control room: how data is structured, who may read which rows, backups, and health. Deeper than the Table Editor's simple grid view.",
  },
  "nav.rail.storage": {
    title: "File storage",
    body: "Where uploaded files (images, documents) live, sorted into buckets — top-level folders with their own access rules. Manage files and access here.",
  },
  "nav.rail.edge-functions": {
    title: "Edge Functions",
    body: "Small pieces of server code that run on demand without you managing a server. See what's deployed and check each function's activity here.",
  },
  "nav.rail.realtime": {
    title: "Realtime",
    body: "Realtime pushes database changes to connected apps the instant they happen, so screens update without a refresh. Inspect live channels here.",
  },
  "nav.rail.api-docs": {
    title: "API Docs",
    body: "The API is how apps talk to this project over the web. These pages document every table's endpoints with copy-ready code examples.",
  },
  "nav.rail.cron": {
    title: "Scheduled jobs (Cron)",
    body: "Cron runs tasks on a repeating schedule, like “every night at 2am”. Review the jobs the database runs on its own, and their run history.",
  },
  "nav.rail.queues": {
    title: "Message queues",
    body: "A queue is the system's to-do list: work gets added, then processed one item at a time. Watch and manage those lists here.",
  },
  "nav.rail.vault": {
    title: "Secrets vault",
    body: "The vault keeps secrets — passwords, API keys — encrypted inside the database. Store them here instead of pasting them into code or settings.",
  },
  "nav.rail.templates": {
    title: "Message templates",
    body: "Reusable message layouts: write the wording once, then reuse it across sends. Browse, search, and manage the library here.",
  },
  "nav.rail.sms-campaigns": {
    title: "SMS campaigns",
    body: "Text-message sends to a chosen list of contacts. Create campaigns, schedule when they go out, and track delivery per recipient.",
  },
  "nav.rail.email-campaigns": {
    title: "Email Campaigns",
    body: "The EmailBison dashboard: every email campaign with sends, opens, replies, and bounces. An admin links the EmailBison account once; everyone reads it here.",
  },
  "nav.rail.inbox": {
    title: "Reply inbox",
    body: "Every text reply people send back, newest first, matched to the campaign that prompted it. Check here for messages still needing a human.",
  },
  "nav.rail.review-queue": {
    title: "Review queue",
    body: "Sends that stopped moving — failures and maybe-sent cases. Each needs a human decision here; nothing retries or resolves on its own.",
  },
  "nav.rail.suppressions": {
    title: "Do-not-text list",
    body: "People who must never be texted again — mostly because they replied STOP. Campaigns skip everyone on this list automatically.",
  },
  "nav.rail.reports": {
    title: "Usage reports",
    body: "Charts of how the platform is being used — request volume, errors, sign-ins — so you can spot trends and problems over time.",
  },
  "nav.rail.competitor-intel": {
    title: "Competitor Intel",
    body: "A searchable library of competitor material. Ask questions in plain English and get answers drawn from the collected documents.",
  },
  "nav.rail.auth": {
    title: "Sign-in settings",
    body: "Authentication is how the system checks who you are at sign-in. Admins review identity providers, sessions, and user pools here.",
  },
  "nav.rail.users": {
    title: "Users & roles",
    body: "Who can sign in to this console and which sections each person may use. Admins grant or remove access here.",
  },
  "nav.rail.advisors": {
    title: "Advisors",
    body: "Automated checkups that scan the database for security gaps and slow spots, then suggest fixes. Admins review the findings here.",
  },
  "nav.rail.cloud": {
    title: "Cloud features",
    body: "A reference listing Supabase's cloud-only features. This deployment is self-hosted, so most are honestly marked unavailable, with what covers the need instead.",
  },
  "nav.rail.logs": {
    title: "System logs",
    body: "The running record of everything the system did — requests, queries, errors. Admins search it here to investigate problems.",
  },
  "nav.rail.infrastructure": {
    title: "Infrastructure",
    body: "The servers and services this console runs on, and how they fit together. Admins check health and architecture here.",
  },
  "nav.rail.settings": {
    title: "Project settings",
    body: "Project-wide configuration: connection details, keys, and runtime info for the whole project rather than any single tool.",
  },

  // ── User menu (masthead chip) ─────────────────────────────────────────────
  "nav.user.email": {
    title: "Signed-in account",
    body: "The work account you're signed in with. It determines which sections of the console you can see and use.",
  },
  "nav.user.sign-out": {
    title: "Sign out",
    body: "Ends your session here and in the company single sign-on behind it. You'll need to sign in again to get back in.",
  },
};
