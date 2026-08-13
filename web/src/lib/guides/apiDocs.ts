import type { GuideModule } from "./types";

/**
 * OWNER: apiDocs domain — the API Docs / api-reference page.
 * Ids: `api-docs.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const apiDocs: GuideModule = {
  "api-docs.page.header": {
    title: "Your data's web API",
    body: "Every table in the database automatically gets a web API — a URL other programs can call to read or change rows. This page shows ready-to-copy example calls for each table.",
  },
  "api-docs.page.private-note": {
    title: "Keys stay secret",
    body: "Every API call must include a secret key that proves who is asking. The examples print placeholders like $SUPABASE_URL instead of real values, so nothing on this page can leak a credential.",
  },
  "api-docs.page.introspection-unavailable": {
    title: "Table info unavailable",
    body: "The console reads the database's table layout through a helper service (postgres-meta), and it did not answer. No data is lost — refresh once the service is reachable again.",
  },
  "api-docs.page.no-tables": {
    title: "No tables found",
    body: "Examples are generated from the tables in the API-exposed schemas, and none exist yet. Create a table in the Database section and its API examples appear here automatically.",
  },
  "api-docs.toolbar.table-select": {
    title: "Pick a table",
    body: "A table is one grid of rows in the database, named schema.table. Choosing one rewrites every example below for that table's URL and columns.",
  },
  "api-docs.toolbar.language-tabs": {
    title: "Example language",
    body: "The same API can be called three ways: cURL (raw web requests from a terminal), JavaScript (the supabase-js library), or GraphQL (one flexible query endpoint). Pick whichever your project uses.",
  },
  "api-docs.stats.schema": {
    title: "The table's schema",
    body: "A schema is a named folder that groups tables inside the database. Tables in \"public\" answer at plain URLs; any other schema must be named in a header on each request.",
  },
  "api-docs.stats.columns": {
    title: "Column count",
    body: "Columns are the named fields every row in this table has, like spreadsheet headings. This is how many the table currently defines.",
  },
  "api-docs.stats.primary-key": {
    title: "Primary key",
    body: "The primary key is the column whose value uniquely identifies each row. Without one there is no safe way to update or delete a single specific row.",
  },
  "api-docs.schema.columns-table": {
    title: "This table's columns",
    body: "Each row here describes one column of the selected table: its name, its data type, whether a value is required, and any default the database fills in when you omit it.",
  },
  "api-docs.rest.select": {
    title: "Read rows over HTTP",
    body: "A GET request fetches rows and never changes anything. select= chooses which columns come back, and extra query parameters filter which rows.",
  },
  "api-docs.rest.insert": {
    title: "Add rows over HTTP",
    body: "A POST request adds new rows; the JSON body holds the column values. Run against the live URL with a real key, it genuinely writes to the database.",
  },
  "api-docs.rest.update": {
    title: "Change rows over HTTP",
    body: "A PATCH request rewrites columns on every row the URL filter matches. Keep the filter — without one, every row in the table would be changed.",
  },
  "api-docs.rest.delete": {
    title: "Delete rows over HTTP",
    body: "A DELETE request permanently removes every row the URL filter matches — there is no undo. Check the filter carefully before running this against real data.",
  },
  "api-docs.js.select": {
    title: "Read rows in JavaScript",
    body: "supabase-js wraps the API in code: .from() names the table and .select() fetches rows. Reading never changes data.",
  },
  "api-docs.js.insert": {
    title: "Add rows in JavaScript",
    body: ".insert() adds the object you pass as a new row, with keys matching column names. With a real key this writes to the live database.",
  },
  "api-docs.js.update": {
    title: "Change rows in JavaScript",
    body: ".update() rewrites columns on the rows matched by the .eq() filter. Keep the filter — without one, every row in the table would change.",
  },
  "api-docs.js.delete": {
    title: "Delete rows in JavaScript",
    body: ".delete() permanently removes the rows matched by the filter — there is no undo. Always pair it with .eq() so only the intended rows are destroyed.",
  },
  "api-docs.graphql.query": {
    title: "Query via GraphQL",
    body: "GraphQL is a query language where one request names exactly the fields you want back. Each table appears as a Collection whose rows sit inside edges/node wrappers — a paging convention called Relay.",
  },
};
