import type { GuideModule } from "./types";

/**
 * OWNER: authAdmin domain — Authentication pages + /admin/users roles, /admin/cloud, /admin/advisors.
 * Ids: `auth-admin.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const authAdmin: GuideModule = {
  // ── Shared across the Authentication tab set ────────────────────────────
  "auth-admin.auth.tabs": {
    title: "Authentication sections",
    body: "Switches between the authentication views: Overview (how sign-in works), Users (accounts in the built-in auth service), Providers (sign-in settings), and Impersonation (preview data as another user).",
  },
  "auth-admin.auth.reference-note": {
    title: "Reference, not live data",
    body: "This block is documentation drawn from the infrastructure code, not a live reading — the real values live in the systems the note names.",
  },

  // ── /admin/auth — identity & access overview ────────────────────────────
  "auth-admin.overview.header": {
    title: "Who can sign in",
    body: "A reference map of sign-in for this console: identity lives in AWS Cognito (the user directory), and membership in named groups decides which pages each person can open.",
  },
  "auth-admin.overview.session": {
    title: "Your current sign-in",
    body: "The identity you are signed in with right now, and the groups attached to it. Groups are named access levels — they decide which parts of this console you can use.",
  },
  "auth-admin.overview.pools-table": {
    title: "User pools",
    body: "Each row is a user pool — a separate directory of accounts inside AWS Cognito, the service that handles sign-in here. Separate pools keep console users apart from other audiences.",
  },
  "auth-admin.overview.groups-table": {
    title: "Access groups",
    body: "Each row is a group — a named bundle of permissions. Putting a person in a group grants everything listed for it; the granting itself happens on the Users & Roles page.",
  },
  "auth-admin.overview.signin-model": {
    title: "How sign-in works",
    body: "The identity provider is the system that checks who you are at sign-in; the session is how the browser stays signed in afterwards. Reference only — nothing here is editable.",
  },

  // ── /admin/auth/providers — GoTrue configuration (read-only) ────────────
  "auth-admin.providers.header": {
    title: "Sign-in configuration",
    body: "Live settings read from GoTrue, the sign-in service bundled with Supabase. Display-only: this app actually signs people in through Cognito, so nothing here affects who can log in today.",
  },
  "auth-admin.providers.flags": {
    title: "Sign-in providers",
    body: "A provider is a way to sign in — email, phone, or an outside account like Google. This lists which ones GoTrue would accept; none carry real logins until sign-in moves off Cognito.",
  },
  "auth-admin.providers.saml-flag": {
    title: "SAML on or off",
    body: "SAML is the protocol companies use for single sign-on. This shows whether the sign-in service is built to accept SAML connections at all — changing it takes an operator restarting the server.",
  },
  "auth-admin.providers.sso-table": {
    title: "Company sign-on connections",
    body: "Each row is a registered SSO connection — single sign-on lets a whole company log in through its own identity system using SAML. These change only by deliberate operator action.",
  },
  "auth-admin.providers.sso-empty": {
    title: "No SSO connections",
    body: "GoTrue has no company sign-on (SAML) connection registered, so there is nothing to list — everyone continues to sign in through Cognito.",
  },
  "auth-admin.providers.templates-table": {
    title: "Auth email templates",
    body: "Each row is one automatic email the sign-in service can send (invites, password recovery, and so on) with the server variable that sets it. Names only — the content has no read API.",
  },
  "auth-admin.providers.mfa": {
    title: "Multi-factor authentication",
    body: "MFA asks for a second proof of identity, like a phone code, on top of a password. There is no live global setting to read here, so this lists where each piece can actually be seen.",
  },
  "auth-admin.providers.unreachable": {
    title: "GoTrue did not answer",
    body: "The built-in sign-in service could not be reached, so its settings cannot be shown. Sign-in to this console runs through Cognito and keeps working.",
  },
  "auth-admin.providers.unreadable": {
    title: "Settings could not load",
    body: "GoTrue answered but the settings read failed — usually a configuration problem such as a wrong service key. The message shows the exact reason instead of fake data.",
  },

  // ── /admin/auth/impersonate ──────────────────────────────────────────────
  "auth-admin.impersonate.header": {
    title: "See as another user",
    body: "Impersonation runs a query as a chosen user to check exactly what data that person can see — the way to test per-user access rules. Every run is logged, and the borrowed credential never leaves the server.",
  },

  // ── /admin/auth/users — GoTrue accounts (read-only) ─────────────────────
  "auth-admin.users.header": {
    title: "Auth service accounts",
    body: "Accounts stored in GoTrue, the sign-in service bundled with Supabase. Read-only: today the app signs people in through Cognito, so this list stays empty until that changes.",
  },
  "auth-admin.users.filter": {
    title: "Find a user",
    body: "Type part of an email address or full name, then press Search. The match runs on the server against every account, not just the rows on screen.",
  },
  "auth-admin.users.sort": {
    title: "Sort by signup date",
    body: "Orders rows by when the account was created — the only sortable column. Click to flip between newest-first and oldest-first.",
  },
  "auth-admin.users.refresh": {
    title: "Reload the list",
    body: "Fetches the current page again so you see changes made elsewhere. It also clears any expanded row details, which are refetched fresh.",
  },
  "auth-admin.users.table": {
    title: "User accounts",
    body: "Each row is one account in the sign-in service: who they are, when they joined, their last sign-in, and status. Banned means sign-in is blocked until a set time.",
  },
  "auth-admin.users.expand": {
    title: "Show account detail",
    body: "Opens the row to show linked identities (each way this person can sign in), any extra verification factors, and the raw metadata stored on the account.",
  },
  "auth-admin.users.pagination": {
    title: "Move between pages",
    body: "The list loads 50 accounts at a time. Previous and Next step through the pages; the caption shows where you are and the total count.",
  },
  "auth-admin.users.unreachable": {
    title: "GoTrue did not answer",
    body: "This list is read live from the sign-in service, and it did not respond — so nothing shown here means unknown, not zero users. The rest of the console is unaffected.",
  },
  "auth-admin.users.empty": {
    title: "Empty on purpose",
    body: "Zero accounts is the honest state today: everyone signs in through Cognito, not this service. It fills up only when sign-in is switched over — a change that has not happened yet.",
  },

  // ── /admin/users — Users & Roles (Cognito grants) ───────────────────────
  "auth-admin.roles.header": {
    title: "Grant and remove access",
    body: "The one place access is actually granted: each person's row has chips for the areas they may use. Changes take effect only after that person signs out and back in.",
  },
  "auth-admin.roles.refresh": {
    title: "Reload the user list",
    body: "Fetches the user list again from the directory so you see grants made by others. It changes nothing by itself.",
  },
  "auth-admin.roles.table": {
    title: "People and their access",
    body: "Each row is one account from the sign-in directory: status, join date, and access chips. A lit chip means the person holds that access; a disabled status means they cannot sign in at all.",
  },
  "auth-admin.roles.toggle": {
    title: "Access toggle",
    body: "Click to grant or remove this area of the console for this person. The change saves immediately but only takes effect after they sign out and back in.",
  },
  "auth-admin.roles.god-mode": {
    title: "Full admin access",
    body: "God-mode grants every page, including this one — treat it like a master key. You cannot change your own chip (so no one locks themselves out), and changes apply after the person signs out and back in.",
  },
  "auth-admin.roles.unreachable": {
    title: "Directory did not answer",
    body: "The Cognito user directory could not be reached, so access can be neither read nor changed right now. Try again shortly — nothing was modified.",
  },

  // ── /admin/cloud — hosted-platform posture ──────────────────────────────
  "auth-admin.cloud.header": {
    title: "Hosted-platform features",
    body: "Supabase's paid cloud service ships extras that self-hosted installs like this one cannot have. This page says so honestly and shows what fills each gap here instead.",
  },
  "auth-admin.cloud.features-table": {
    title: "Feature availability",
    body: "Each row is one hosted-platform feature with its honest status here. N/A means it lives in Supabase's cloud control plane — infrastructure this self-hosted install simply does not have.",
  },
  "auth-admin.cloud.capability-list": {
    title: "Why they are absent",
    body: "The reason each feature cannot exist in this deployment: they depend on servers Supabase itself operates. Nothing is misconfigured, and there is no switch to find.",
  },
  "auth-admin.cloud.coverage-list": {
    title: "What covers it here",
    body: "For every missing cloud feature, the thing in this stack that already does the same job — for example, reviewed migrations and restorable backups stand in for branching.",
  },
  "auth-admin.cloud.assistant-list": {
    title: "AI assistant status",
    body: "The one exception: instead of Supabase's assistant, this console runs its own on the SQL page. It reads table structure only — never row data — and only proposes SQL; it cannot run anything itself.",
  },

  // ── /admin/advisors — automated checks ──────────────────────────────────
  "auth-admin.advisors.header": {
    title: "Automated health checks",
    body: "Advisors scan the database for known security and performance problems — like tables anyone could read, or missing indexes that slow queries. They only report findings; they change nothing.",
  },
  "auth-admin.advisors.unavailable": {
    title: "Checks could not run",
    body: "The service that inspects the database structure did not answer, so no checks ran. This is an outage of the inspector, not a finding — refresh in a moment.",
  },
  "auth-admin.advisors.level-filter": {
    title: "Filter by check type",
    body: "Security checks look for exposure risks, like tables without access rules; performance checks look for slowness, like missing indexes. Pick one type or All and the suite re-runs scoped to it.",
  },
  "auth-admin.advisors.rerun": {
    title: "Run checks again",
    body: "Runs the whole check suite against the database right now — useful after a fix, to confirm the finding clears. Reading only; nothing is changed.",
  },
  "auth-admin.advisors.severity-stats": {
    title: "Findings by severity",
    body: "Counts of current findings: Errors need fixing, Warnings are worth reviewing, Info is context. Zero across the board means every check passed.",
  },
  "auth-admin.advisors.failed-table": {
    title: "Checks that errored",
    body: "These individual checks crashed instead of finishing, so their part of the picture is missing — every other check still ran and is reported below.",
  },
  "auth-admin.advisors.findings-table": {
    title: "Individual findings",
    body: "Each row is one problem found: which check fired, the database object involved, and how to fix it. Rest the pointer on a shortened cell to read its full text.",
  },
  "auth-admin.advisors.clear": {
    title: "All checks passed",
    body: "No findings at the selected scope — the database currently passes every advisor check. Re-run any time; results reflect the database as it is now.",
  },
};
