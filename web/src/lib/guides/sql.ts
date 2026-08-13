import type { GuideModule } from "./types";

/**
 * OWNER: sql domain — the SQL Editor page + its AI assistant rail.
 * Ids: `sql.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const sql: GuideModule = {
  // ── Page ──
  "sql.page.header": {
    title: "The SQL Editor",
    body: "SQL is the language used to ask a database questions and to change its data. Type a statement here, run it against this project's live database, and see the results — every run is recorded in the history.",
  },

  // ── Editor + toolbar ──
  "sql.editor.input": {
    title: "Where you write SQL",
    body: "A SQL statement is a typed instruction like 'show every campaign'. Write one here and press Run (or Cmd/Ctrl+Enter) — nothing touches the database until you run it.",
  },
  "sql.editor.run": {
    title: "Run the statement",
    body: "Sends your SQL to the database and shows the result below. Statements that only read data run right away; anything that would change data stops for a second, explicit confirm first.",
  },
  "sql.editor.write-warning": {
    title: "Write detected",
    body: "The server could not prove this statement only reads data, so it treats it as a write — one that adds, changes, or deletes rows. Nothing has run yet; it waits for your explicit confirm.",
  },
  "sql.editor.run-write": {
    title: "Confirm the write",
    body: "Runs the statement even though it will change the database — rows may be added, updated, or deleted for real, with no undo. Click only if you understand what this SQL does.",
  },
  "sql.editor.cancel-write": {
    title: "Back out safely",
    body: "Dismisses the write confirmation without running anything. The database is untouched and your SQL stays in the editor.",
  },
  "sql.editor.result-meta": {
    title: "Result size and speed",
    body: "How many rows came back and how long the database took. At most the first 1,000 rows are shown here; a bigger result says so and is cut off at that point.",
  },
  "sql.editor.export-csv": {
    title: "Download results",
    body: "Saves the rows shown below as a CSV file — a plain spreadsheet format that Excel and Google Sheets open. Only the rows already fetched (up to 1,000) are included.",
  },
  "sql.editor.save-snippet": {
    title: "Save for later",
    body: "A snippet is a saved, named SQL statement. This stores the editor's current text in the shared Snippets list so you and your teammates can reload it with one click.",
  },
  "sql.editor.snippet-name": {
    title: "Name the snippet",
    body: "A short label so the saved SQL is recognizable later, like 'weekly campaign counts'. Everyone who uses this editor sees the same snippet list.",
  },
  "sql.editor.snippet-save": {
    title: "Store the snippet",
    body: "Adds the editor's current SQL to the shared list under this name. Saving only stores text — it never runs the statement.",
  },
  "sql.editor.snippet-cancel": {
    title: "Close without saving",
    body: "Puts the naming box away without storing anything. Your SQL stays in the editor exactly as it is.",
  },
  "sql.editor.error": {
    title: "Database error message",
    body: "The database refused the last run; this is its exact error text. Failed statements are rolled back — nothing was changed — so fix the SQL and run again.",
  },
  "sql.editor.results": {
    title: "Query results",
    body: "Each row is one record the database returned for your statement, one column per selected field. Long values are shortened — hover a cell to see the full text.",
  },
  "sql.editor.no-rows": {
    title: "Ran, nothing to return",
    body: "The statement succeeded but had no rows to show — normal for writes like INSERT or UPDATE, which change data rather than return it.",
  },

  // ── Snippets rail ──
  "sql.snippets.list": {
    title: "Saved snippets",
    body: "Each entry is a SQL statement someone saved for reuse; the list is shared by everyone here. Click a name to load it into the editor — loading never runs it.",
  },
  "sql.snippets.load": {
    title: "Load this snippet",
    body: "Replaces whatever is in the editor with this saved SQL. It only loads — nothing runs until you press Run, and any pending write confirm is reset.",
  },
  "sql.snippets.delete": {
    title: "Delete this snippet",
    body: "Starts removing this snippet from the shared list — you'll get a confirm step before anything is deleted. Only the saved text goes away; no database data is touched.",
  },
  "sql.snippets.delete-confirm": {
    title: "Really delete it",
    body: "Permanently removes this snippet for everyone — there is no undo. It deletes only the saved text, never your actual data.",
  },

  // ── History rail ──
  "sql.history.list": {
    title: "Query history",
    body: "The audit log of statements run in this editor, newest first, with time and outcome — the server also records who ran each one. Click an entry to load its SQL back into the editor.",
  },
  "sql.history.entry": {
    title: "Reload a past query",
    body: "Puts this previously-run statement back in the editor so you can tweak or rerun it. The timestamp plus row count or error badge shows how the original run went.",
  },

  // ── AI assistant rail ──
  "sql.assistant.question": {
    title: "Ask the AI assistant",
    body: "An AI helper that knows this database's structure. Ask a plain-English question and it answers or drafts SQL for you — it can never run anything on its own.",
  },
  "sql.assistant.ask": {
    title: "Send your question",
    body: "Submits the question; an answer usually arrives within a few seconds. Asking again replaces the previous answer — there is no chat history.",
  },
  "sql.assistant.unavailable": {
    title: "Assistant is offline",
    body: "The AI gateway this assistant depends on is not configured in this environment, so questions cannot be answered right now. The rest of the SQL editor still works normally.",
  },
  "sql.assistant.proposal": {
    title: "Suggested SQL",
    body: "The statement the assistant drafted for your question. It has not run — read it first, then use Replace editor if you want to try it yourself.",
  },
  "sql.assistant.replace": {
    title: "Copy into the editor",
    body: "Replaces everything in the editor with this suggestion — your current SQL is overwritten, not merged. It still does not run; you press Run yourself, and writes still need their confirm.",
  },
};
