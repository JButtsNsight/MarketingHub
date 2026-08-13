import type { GuideModule } from "./types";

/**
 * OWNER: database-platform domain — Extensions, Roles, Functions (DB),
 * Triggers, Indexes, Types, Publications, Webhooks.
 * Ids: `db-platform.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const databasePlatform: GuideModule = {
  // ── Shared across the Database platform pages ────────────────────────────
  "db-platform.common.tabs": {
    title: "Database section tabs",
    body: "Each tab is a different view of the same Postgres database — tables, security rules, extensions, and more. Switching tabs only changes what you are looking at.",
  },
  "db-platform.common.introspection-unavailable": {
    title: "Database info unavailable",
    body: "This page reads live details from the database through a helper service, and that service did not answer. Your data is untouched — refresh in a moment to retry.",
  },
  "db-platform.common.refresh": {
    title: "Reload from database",
    body: "Re-reads the live list from the database in case something changed outside this page. Purely a read — nothing is modified.",
  },

  // ── Extensions ────────────────────────────────────────────────────────────
  "db-platform.extensions.header": {
    title: "Postgres extensions",
    body: "Extensions are optional add-on packages that give the Postgres database extra abilities, like scheduled jobs or geographic data. This page shows which are installed and lets you enable or remove them.",
  },
  "db-platform.extensions.table": {
    title: "Extension catalog",
    body: "Every extension this database knows about, one per row. A green version badge means it is installed and active; 'available' means it exists but is not turned on.",
  },
  "db-platform.extensions.enable": {
    title: "Enable an extension",
    body: "Installs this add-on into the database with full administrator rights, which can add new tables, functions, and schemas. You are asked to confirm before anything runs.",
  },
  "db-platform.extensions.drop": {
    title: "Drop an extension",
    body: "Permanently uninstalls this extension and can also delete every object that depends on it. It cannot be undone from here, so a confirmation is required first.",
  },

  // ── Roles ─────────────────────────────────────────────────────────────────
  "db-platform.roles.header": {
    title: "Database roles",
    body: "A role is a database account: it can sign in like a user or just group permissions. This page lists every role, its powers, and which roles belong to which groups.",
  },
  "db-platform.roles.create": {
    title: "Create a role",
    body: "Opens a form to add a new database account with the powers you choose. Nothing is created until you submit and confirm.",
  },
  "db-platform.roles.table": {
    title: "Role catalog",
    body: "One row per role. Badges flag risky powers — 'superuser' can do anything, and 'bypassrls' skips Row Level Security, the feature that limits which rows each user may see.",
  },
  "db-platform.roles.alter": {
    title: "Alter this role",
    body: "Opens a form to change this role's powers, connection limit, expiry, or password. Changes apply to the live database as soon as you save and confirm.",
  },
  "db-platform.roles.drop": {
    title: "Drop this role",
    body: "Permanently deletes this database account after a confirmation. It cannot be undone, and it fails if the role still owns tables or holds permissions.",
  },
  "db-platform.roles.protected": {
    title: "Protected role",
    body: "This role is part of the platform's own plumbing, so editing and deleting are disabled here — the server refuses changes to it too. Manage it through migrations instead.",
  },
  "db-platform.roles.memberships-table": {
    title: "Role memberships",
    body: "Roles can belong to other roles, inheriting their permissions like a group. Each row is one grant: which member belongs to which group role, and who granted it.",
  },
  "db-platform.roles.name-field": {
    title: "New role name",
    body: "The identifier for the new account: start with a letter or underscore, then letters, digits, or underscores. It cannot be renamed from this page later.",
  },
  "db-platform.roles.attr-login": {
    title: "Can login",
    body: "Whether this role may sign in to the database directly, like a user account. Leave it off for roles that only exist to group permissions.",
  },
  "db-platform.roles.attr-superuser": {
    title: "Superuser",
    body: "A superuser skips every permission check and can read, change, or delete anything in the database. Grant it only when nothing less will do.",
  },
  "db-platform.roles.attr-createrole": {
    title: "Create roles",
    body: "Lets this role create, alter, and drop other roles — effectively account administration. A powerful right, since it can mint new access.",
  },
  "db-platform.roles.attr-createdb": {
    title: "Create databases",
    body: "Lets this role create brand-new databases on this server. Rarely needed here, where everything lives in one database.",
  },
  "db-platform.roles.attr-replication": {
    title: "Replication",
    body: "Lets this role stream the database's raw change feed, which is how standby copies stay in sync. It effectively exposes all data, so treat it like superuser.",
  },
  "db-platform.roles.attr-bypassrls": {
    title: "Bypass RLS",
    body: "Row Level Security (RLS) decides which rows each user is allowed to see. A role with this flag skips those checks and sees every row, so grant it with care.",
  },
  "db-platform.roles.conn-limit": {
    title: "Connection limit",
    body: "The most simultaneous connections this role may open to the database. -1 means unlimited; a low number stops a runaway app from hogging connections.",
  },
  "db-platform.roles.valid-until": {
    title: "Password expiry",
    body: "A timestamp after which this role's password stops working — useful for temporary access. Leave blank for no expiry.",
  },
  "db-platform.roles.password": {
    title: "Role password",
    body: "The password the role uses to sign in — only meaningful if it can log in. When altering, leaving this blank keeps the current password.",
  },
  "db-platform.roles.form-submit": {
    title: "Apply role changes",
    body: "Sends the settings above to the database as the administrator, after one more confirmation. Creating adds the account; altering changes its powers immediately.",
  },

  // ── Functions (database routines) ────────────────────────────────────────
  "db-platform.functions.header": {
    title: "Database functions",
    body: "A database function is a reusable piece of code stored inside Postgres itself, runnable from queries or triggers. This page lists every function in the app's schemas.",
  },
  "db-platform.functions.table": {
    title: "Function catalog",
    body: "One row per stored function: its arguments, return type, and language. 'definer' means it runs with its owner's permissions instead of the caller's — worth watching, since it can do more than the user could.",
  },
  "db-platform.functions.definition": {
    title: "View source code",
    body: "Shows the full code of this function in a panel below the table. Just a read — nothing runs or changes.",
  },
  "db-platform.functions.drop": {
    title: "Drop this function",
    body: "Permanently deletes this function from the database after a confirmation. It cannot be undone, and triggers, views, or other code that call it may break.",
  },

  // ── Triggers ──────────────────────────────────────────────────────────────
  "db-platform.triggers.header": {
    title: "Table triggers",
    body: "A trigger is a rule that makes the database run a function automatically whenever rows in a table are inserted, updated, or deleted. This page lists them and lets you pause or remove them.",
  },
  "db-platform.triggers.table": {
    title: "Trigger catalog",
    body: "One row per trigger: the table it watches, when it fires, which events start it, and the function it runs. Disabled triggers stay defined but do nothing.",
  },
  "db-platform.triggers.toggle": {
    title: "Pause or resume trigger",
    body: "Disabling stops this trigger from firing on future writes without deleting it; enabling turns it back on. Either way you confirm first, and the change is immediate.",
  },
  "db-platform.triggers.drop": {
    title: "Drop this trigger",
    body: "Permanently deletes this trigger after a confirmation — the automatic behavior it provided stops for good. The function it called stays; only the trigger is removed.",
  },

  // ── Indexes ───────────────────────────────────────────────────────────────
  "db-platform.indexes.header": {
    title: "Database indexes",
    body: "An index is a lookup structure that makes finding rows in a table fast, like a book's index. This page shows each index's size and use, and lets you create or drop them.",
  },
  "db-platform.indexes.create": {
    title: "Create an index",
    body: "Opens a form to build a new index from a table, columns, and method — no SQL required. Nothing runs until you submit and confirm.",
  },
  "db-platform.indexes.filter": {
    title: "Filter the list",
    body: "Type to narrow the rows below by index or table name. It only filters what you see — nothing in the database changes.",
  },
  "db-platform.indexes.table": {
    title: "Index catalog",
    body: "One row per index with its size and scan count (how many times queries used it). A non-primary index with 0 scans is dead weight: it costs storage and slows writes without helping reads.",
  },
  "db-platform.indexes.drop": {
    title: "Drop this index",
    body: "Permanently deletes this index after a confirmation. The table's data is untouched, but queries that relied on it may become much slower.",
  },
  "db-platform.indexes.table-picker": {
    title: "Table to index",
    body: "The table the new index will speed up. Picking a table loads its columns below.",
  },
  "db-platform.indexes.name-field": {
    title: "Index name",
    body: "What the new index will be called — pick something descriptive, like the table plus columns. Names must be unique within a schema.",
  },
  "db-platform.indexes.method": {
    title: "Index method",
    body: "How Postgres organizes the index internally. btree is the safe default for most lookups and sorting; gin suits arrays and JSON; the others cover special cases.",
  },
  "db-platform.indexes.unique": {
    title: "Unique constraint",
    body: "Makes the database reject two rows with the same value in the indexed columns. Use it to enforce things like one account per email.",
  },
  "db-platform.indexes.columns": {
    title: "Columns to index",
    body: "Pick one or more columns from the chosen table; queries that filter or sort by them get faster. Order matters — the first column is the primary sort.",
  },
  "db-platform.indexes.preview": {
    title: "Generated SQL preview",
    body: "The exact statement the form will run, updated live as you change the fields. Display only — the server rebuilds and re-checks it before executing.",
  },
  "db-platform.indexes.submit": {
    title: "Build the index",
    body: "Runs the statement above as the database administrator, after a confirmation. Building an index on a large table can block writes to it until it finishes.",
  },

  // ── Enumerated types ─────────────────────────────────────────────────────
  "db-platform.types.header": {
    title: "Enumerated types",
    body: "An enum is a custom column type with a fixed list of allowed values, like status = draft, sent, or failed. This page lists the database's enums and lets you create, extend, or drop them.",
  },
  "db-platform.types.create": {
    title: "Create an enum type",
    body: "Opens a form to define a new enum: a name plus the list of values its columns may hold. Nothing is created until you submit and confirm.",
  },
  "db-platform.types.schema": {
    title: "Schema for the type",
    body: "A schema is a named folder inside the database that groups related objects. The new enum will live in the one you pick.",
  },
  "db-platform.types.name-field": {
    title: "Type name",
    body: "What the new enum will be called, used later as a column type. Start with a letter or underscore; keep it short and descriptive.",
  },
  "db-platform.types.values": {
    title: "Allowed values",
    body: "Type a value and press Enter (or Add value) to stage it; click a staged chip to remove it before creating. These become the only values columns of this type accept.",
  },
  "db-platform.types.submit": {
    title: "Create the type",
    body: "Runs CREATE TYPE with the name and values above, after a confirmation. Once created, values can be added later but never removed.",
  },
  "db-platform.types.table": {
    title: "Enum catalog",
    body: "One row per enum type, with every value it currently allows. Columns elsewhere in the database can use these types to restrict their contents.",
  },
  "db-platform.types.add-value": {
    title: "Add a value",
    body: "Opens a small editor to append one new allowed value to this enum. Adding is permanent — Postgres can never remove a value once it exists.",
  },
  "db-platform.types.value-editor": {
    title: "New value to add",
    body: "Type the value and press Enter or Add to append it after a confirmation. This is irreversible: an enum value can never be removed once added.",
  },
  "db-platform.types.drop": {
    title: "Drop this type",
    body: "Permanently deletes this enum after a confirmation. It fails safely if any table column still uses the type; otherwise it cannot be undone.",
  },

  // ── Publications (logical replication) ───────────────────────────────────
  "db-platform.publications.header": {
    title: "Replication publications",
    body: "A publication is a named change feed: outside systems subscribe to it to receive row changes from chosen tables in real time. This page manages which tables and operations each feed carries.",
  },
  "db-platform.publications.create": {
    title: "New publication",
    body: "Opens a form to define a new change feed: a name, which tables it covers, and which operations it broadcasts. Nothing is created until you submit and confirm.",
  },
  "db-platform.publications.table": {
    title: "Publication catalog",
    body: "One row per publication with its owner, scope, and broadcast operations. 'all tables' means every table in the database is streamed — including ones created later.",
  },
  "db-platform.publications.edit": {
    title: "Edit this publication",
    body: "Opens a form to change which operations this feed broadcasts and, for table-scoped feeds, which tables it includes. Subscribers see the new behavior once you save and confirm.",
  },
  "db-platform.publications.drop": {
    title: "Drop this publication",
    body: "Permanently removes this change feed after a confirmation. Table data is untouched, but any subscriber reading the feed stops receiving changes and cannot resume from it.",
  },
  "db-platform.publications.name-field": {
    title: "Publication name",
    body: "The identifier subscribers use to attach to this feed. It is fixed at creation and cannot be edited afterwards on this page.",
  },
  "db-platform.publications.all-tables": {
    title: "Publish every table",
    body: "Streams changes from all tables in the database, including any created in the future. Broad — subscribers see everything, so prefer picking tables unless you truly need it all.",
  },
  "db-platform.publications.operations": {
    title: "Operations to broadcast",
    body: "Which kinds of row change the feed carries: inserts, updates, deletes, and truncates (a truncate empties a whole table at once). Unchecked kinds are simply not sent.",
  },
  "db-platform.publications.member-tables": {
    title: "Tables in the feed",
    body: "Tick the tables whose row changes this publication should carry. When altering, a new selection replaces the old member list; leaving every box empty keeps it unchanged.",
  },
  "db-platform.publications.submit": {
    title: "Save the publication",
    body: "Applies the settings above after a confirmation. Subscribers begin (or stop) receiving the selected changes immediately.",
  },

  // ── Database webhooks ────────────────────────────────────────────────────
  "db-platform.webhooks.header": {
    title: "Database webhooks",
    body: "A database webhook watches a table and calls a web address (HTTP) every time rows are inserted, updated, or deleted — a way to notify outside systems of changes. This page lists, creates, and removes them.",
  },
  "db-platform.webhooks.pg-net-status": {
    title: "Outbound HTTP safety check",
    body: "Webhooks let the database itself call the internet, which is risky if unrestricted. This banner shows whether the migration limiting that ability to one dedicated role is applied; until it is, creating webhooks is refused.",
  },
  "db-platform.webhooks.create": {
    title: "New webhook",
    body: "Opens a form to watch a table and call a URL on row changes. Disabled until the outbound-HTTP safety migration is applied; nothing is created until you submit and confirm.",
  },
  "db-platform.webhooks.table": {
    title: "Webhook catalog",
    body: "One row per webhook: the table it watches, the events that fire it, and the URL it calls. Disabled webhooks stay defined but stop calling out.",
  },
  "db-platform.webhooks.drop": {
    title: "Drop this webhook",
    body: "Permanently deletes this webhook after a confirmation. The table and its data are untouched, but its changes stop being sent to the target URL — irreversibly.",
  },
  "db-platform.webhooks.name-field": {
    title: "Webhook name",
    body: "An identifier for this webhook (it becomes the trigger's name on the table). Start with a letter or underscore, then letters, digits, or underscores.",
  },
  "db-platform.webhooks.table-picker": {
    title: "Table to watch",
    body: "The table whose row changes will fire this webhook. Only changes to this one table trigger the call.",
  },
  "db-platform.webhooks.events": {
    title: "Events that fire it",
    body: "Which row changes trigger the call: inserts (new rows), updates (edited rows), or deletes (removed rows). Pick at least one.",
  },
  "db-platform.webhooks.method": {
    title: "HTTP method",
    body: "How the request is sent: POST carries the changed row's data in the request body (the usual choice); GET just pings the URL.",
  },
  "db-platform.webhooks.url": {
    title: "Target URL",
    body: "The full web address the database will call on every matching row change. It must start with http:// or https://, and the receiving service must be reachable from the database.",
  },
  "db-platform.webhooks.headers": {
    title: "Request headers",
    body: "Optional extra fields sent with every call, as JSON text mapping names to values — often used for auth tokens the receiver checks. Leave the default for plain JSON delivery.",
  },
  "db-platform.webhooks.submit": {
    title: "Create the webhook",
    body: "Creates the watcher after a confirmation. From then on, every matching row change makes the database send an HTTP request to the target URL.",
  },
};
