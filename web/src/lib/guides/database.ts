import type { GuideModule } from "./types";

/**
 * OWNER: database domain — Table Editor, Database section (schema, policies, designer, extensions, roles, functions, triggers, indexes, types, publications, webhooks).
 * Ids: `database.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const database: GuideModule = {
  // --- Shared across the Database section's pages -------------------------
  "database.section.tabs": {
    title: "Database section pages",
    body: "The Database area's sub-pages: the live schema reference, row-access policies, functions, backups, and more. The Table Editor is separate, in the left navigation.",
  },
  "database.section.introspection-missing": {
    title: "Live schema unavailable",
    body: "This page builds itself by asking the database to describe its own tables (introspection), and that lookup failed. Nothing is lost — refresh once the data API answers.",
  },

  // --- Table Editor (/database) --------------------------------------------
  "database.editor.page": {
    title: "Table Editor",
    body: "A spreadsheet-like view of the live database. Pick a table on the left to browse, filter, edit, add, or delete its rows — changes apply to real data immediately.",
  },
  "database.editor.table-select": {
    title: "Open a table",
    body: "Tables are grouped by schema — a named folder inside the database. Click a table to load its rows; the number is the database's row-count estimate, not an exact count.",
  },
  "database.editor.table-status": {
    title: "Row count and mode",
    body: "The exact number of rows matching the current filters. Tables without a primary key (a column that uniquely identifies each row) are browse-only — rows can't be safely edited or deleted.",
  },
  "database.editor.export-csv": {
    title: "Download this page",
    body: "Saves only the rows currently shown — this page, with filters applied — as a CSV file Excel or Sheets can open. It never exports the whole table.",
  },
  "database.editor.refresh": {
    title: "Reload from the database",
    body: "Re-reads the rows and the table list so the grid shows what is in the database right now. Useful after someone or something else changes data.",
  },
  "database.editor.delete-selected": {
    title: "Delete checked rows",
    body: "Permanently removes every checked row from the live table after one more confirming click. There is no undo and no trash — deleted rows are gone.",
  },
  "database.editor.confirm-delete": {
    title: "Really delete",
    body: "The final step: clicking this removes the checked rows from the live database for good. Click Keep instead to back out.",
  },
  "database.editor.keep-rows": {
    title: "Keep the rows",
    body: "Backs out of the delete — nothing is removed, and your row selection stays as it was.",
  },
  "database.editor.insert-toggle": {
    title: "Add a row",
    body: "Opens a form with one box per column so you can add a new row to this table. Nothing is written until you submit the form.",
  },
  "database.editor.filter-column": {
    title: "Filter column",
    body: "Filters narrow the grid to matching rows. Start here by picking which column the condition should test.",
  },
  "database.editor.filter-operator": {
    title: "How to compare",
    body: "The comparison to apply: = and ≠ match exactly, the arrows compare numbers or dates, ilike matches text ignoring case (% is a wildcard), and is tests for empty (NULL) values.",
  },
  "database.editor.filter-value": {
    title: "Value to match",
    body: "What the column is compared against. With ilike, % stands for any text — %alpha% finds rows containing alpha anywhere.",
  },
  "database.editor.filter-add": {
    title: "Apply the condition",
    body: "Adds the condition and reloads the grid from page 1. Multiple filters combine — a row must match all of them to stay visible.",
  },
  "database.editor.filter-chip": {
    title: "Active filter",
    body: "One condition currently narrowing the rows. Click the chip to remove just that condition; the grid reloads without it.",
  },
  "database.editor.insert-form": {
    title: "New row fields",
    body: "One box per column. Blank boxes are left to the database's default; the NULL box stores an explicit no-value; dropdowns list valid choices, including rows from a linked table.",
  },
  "database.editor.insert-submit": {
    title: "Write the row",
    body: "Inserts the new row into the live table immediately. If a required value is missing or invalid, the database rejects it and the error appears here.",
  },
  "database.editor.grid": {
    title: "The table's rows",
    body: "Live rows read straight from the database. Click a column header to sort, tick boxes to select rows, and double-click a cell to edit it in place.",
  },
  "database.editor.pager": {
    title: "Page through rows",
    body: "Rows load one page at a time to stay fast. Prev and Next step through pages; the dropdown sets how many rows each page shows.",
  },

  // --- Editable grid internals (shared by grid surfaces) -------------------
  "database.grid.select-all": {
    title: "Select the page",
    body: "Checks every row on this page at once — not the whole table — so a bulk action like delete can target them together. Click again to clear.",
  },
  "database.grid.select-row": {
    title: "Select this row",
    body: "Marks this row so toolbar actions like delete can target it. Check several rows to act on them in one go.",
  },
  "database.grid.sort": {
    title: "Sort by this column",
    body: "Clicking cycles the order: ascending, then descending, then back to the database's natural order. Sorting re-queries the database, so it covers every page, not just this one.",
  },
  "database.grid.cell-editor": {
    title: "Edit this cell",
    body: "Changes save to the live database: Save or Enter commits, Escape or Cancel discards, and Set NULL stores an explicit empty value. Dropdowns only offer values the column allows.",
  },

  // --- Schema reference (/database/schema) ---------------------------------
  "database.schema.page": {
    title: "Schema reference",
    body: "A schema is the database's blueprint — which tables exist and what each column holds. This page is a live, read-only reference built from the database itself; edit rows in the Table Editor.",
  },
  "database.schema.table-list": {
    title: "Tables in this schema",
    body: "One section per table listing its columns: the data type, whether a value may be empty (nullable), and the default the database fills in when a row omits it.",
  },
  "database.schema.extensions-table": {
    title: "Postgres extensions",
    body: "Extensions are optional add-on packs of database features, like scheduled jobs or geospatial types. A version badge means installed and active; the rest are available but off.",
  },

  // --- RLS policies (/database/rls) -----------------------------------------
  "database.rls.page": {
    title: "Row Level Security",
    body: "Row Level Security (RLS) decides which rows each user may see or change; policies are the rules that grant that access. This page shows every table's RLS state and manages its policies.",
  },
  "database.rls.enabled-stat": {
    title: "Tables with RLS on",
    body: "On these tables every read and write must be allowed by a policy — no matching policy means the request is denied. This is the safe default posture.",
  },
  "database.rls.unprotected-stat": {
    title: "Tables with RLS off",
    body: "RLS is off here, so any request that reaches these tables can read and change every row. Aim for zero — enable RLS and add policies.",
  },
  "database.rls.coverage-table": {
    title: "RLS coverage",
    body: "One row per managed table showing whether Row Level Security is enforced on it. disabled means the table does no per-row checking at all.",
  },
  "database.rls.new-policy": {
    title: "Write a new policy",
    body: "Opens a form to add one access rule to one table. Nothing changes until you submit and confirm — a template can prefill the fields.",
  },
  "database.rls.policies-table": {
    title: "Active policies",
    body: "Every access rule in force right now: the table it guards, the operation it covers (command), who it applies to (roles), and the row test it runs.",
  },
  "database.rls.edit-policy": {
    title: "Change this policy",
    body: "Opens the rule for editing. Postgres only allows changing its name, roles, and row tests after creation — the command and action are fixed.",
  },
  "database.rls.drop-policy": {
    title: "Delete this policy",
    body: "Permanently removes this access rule after a confirmation. If it was the table's only policy, RLS stays on and the table becomes deny-all — there is no undo.",
  },
  "database.rls.template": {
    title: "Starter policy",
    body: "Ready-made rules that prefill the form: full access for the server role, owner-only rows, or public read-only. Pick one, then adjust anything before creating.",
  },
  "database.rls.policy-table": {
    title: "Table to guard",
    body: "The table this rule applies to — a policy only affects reads and writes on its own table. It cannot be moved to another table later.",
  },
  "database.rls.policy-name": {
    title: "Policy name",
    body: "A label for the rule: a letter or underscore first, then letters, digits, or underscores. You can rename it later.",
  },
  "database.rls.policy-command": {
    title: "Operation covered",
    body: "Which kind of request the rule covers — reading (SELECT), adding (INSERT), changing (UPDATE), removing (DELETE), or ALL. It cannot be changed after creation.",
  },
  "database.rls.policy-action": {
    title: "Grant or restrict",
    body: "PERMISSIVE rules grant access; RESTRICTIVE rules narrow what the permissive ones granted — most policies are permissive. This choice is fixed after creation.",
  },
  "database.rls.policy-roles": {
    title: "Who it applies to",
    body: "Comma-separated database roles: anon is a visitor, authenticated a signed-in user, service_role the server itself. Left blank, the rule applies to everyone (public).",
  },
  "database.rls.policy-using": {
    title: "Which rows qualify",
    body: "A true/false SQL test run against each existing row — only rows where it is true can be seen or changed. (select auth.uid()) = user_id limits users to their own rows.",
  },
  "database.rls.policy-check": {
    title: "Which writes are accepted",
    body: "A true/false SQL test run on new or changed values — writes that fail it are rejected. It usually mirrors the using expression so users can't write rows they couldn't read.",
  },
  "database.rls.policy-submit": {
    title: "Apply the policy",
    body: "Shows a confirmation, then runs the change on the live database as an admin-level SQL statement. Access rules take effect immediately for every user.",
  },

  // --- Visual Schema Designer (/database/designer) --------------------------
  "database.designer.page": {
    title: "Schema map",
    body: "A read-only diagram of the database: every card is a table and every line a foreign key — a column that points at rows in another table. Nothing on this page can change the database.",
  },
  "database.designer.schema-chip": {
    title: "Show or hide schema",
    body: "Toggles one schema's tables on the map — a schema is a named group of tables. Dimmed means hidden; its tables and their connection lines disappear until toggled back.",
  },
  "database.designer.clear-focus": {
    title: "Clear the highlight",
    body: "Removes the focus from the selected table so every card and relationship line returns to full strength.",
  },
  "database.designer.canvas": {
    title: "Relationship diagram",
    body: "A scrollable map of every visible table. PK marks a primary key (the row's unique id), FK a foreign key (a link to another table); arrows point at the table being referenced.",
  },
  "database.designer.table-card": {
    title: "One table",
    body: "This card lists the table's columns and types. Click it to spotlight just this table, its direct neighbors, and the foreign keys between them; click again to release.",
  },
};
