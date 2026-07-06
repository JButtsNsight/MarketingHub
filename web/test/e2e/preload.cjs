/**
 * e2e server-side fetch shim (loaded via NODE_OPTIONS="--require ...").
 *
 * The MarketingHub server makes exactly two kinds of outbound fetch we must
 * intercept to run the app end-to-end without real infrastructure:
 *
 *   1. The ALB public-key endpoint (public-keys.auth.elb.<region>.amazonaws.com)
 *      that `src/lib/auth.ts` queries to VERIFY the `x-amzn-oidc-data` ES256
 *      signature. We serve the test public key (PEM) written by globalSetup, so
 *      the token minted with the matching private key verifies for real.
 *
 *   2. The Supabase PostgREST/Storage API at SUPABASE_URL. We back it with a
 *      tiny in-memory `templates` store so create/list/search/get behave like
 *      the real repo against Postgres full-text search — no DB required.
 *
 * Everything else passes through to the real fetch. This runs in the SAME single
 * Node process as `next start`, so `globalThis.fetch` (captured lazily by
 * supabase-js at client construction) and the in-memory store are shared across
 * all requests.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const realFetch = globalThis.fetch.bind(globalThis);
const AUTH_FILE = path.join(__dirname, ".mh-auth.json");

/** In-memory stand-in for marketinghub.templates (persists for the process). */
const store = [];

function readPem() {
  return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")).pem;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `id=eq.<uuid>` → `<uuid>`; returns null when the param is absent. */
function eqValue(params, key) {
  const raw = params.get(key);
  return raw ? raw.replace(/^eq\./, "") : null;
}

/** Concatenated searchable text for a row (mirrors the tsvector columns). */
function searchable(row) {
  return [row.name, (row.tags || []).join(" "), row.category, row.body]
    .join(" ")
    .toLowerCase();
}

/** websearch value `wfts(english).spring promo` → the raw query `spring promo`. */
function websearchTerms(value) {
  return value
    .replace(/^w?fts\([^)]*\)\./, "")
    .split(/[\s+]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function handleTemplates(url, init) {
  const method = ((init && init.method) || "GET").toUpperCase();
  const params = url.searchParams;

  if (method === "POST") {
    const parsed = JSON.parse(init.body);
    const r = Array.isArray(parsed) ? parsed[0] : parsed;
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      name: r.name,
      type: r.type,
      category: r.category,
      tags: r.tags ?? [],
      subject: r.subject ?? null,
      body: r.body,
      storage_path: r.storage_path ?? null,
      created_by: r.created_by,
      created_at: now,
      updated_at: now,
    };
    store.push(row);
    // createTemplate uses .insert(...).select().single() → a single object.
    return jsonResponse(row, 201);
  }

  if (method === "PATCH") {
    // createTemplate's storage-path update uses .update(...).eq().select().single().
    const id = eqValue(params, "id");
    const patch = JSON.parse(init.body);
    const row = store.find((x) => x.id === id);
    if (row) Object.assign(row, patch, { updated_at: new Date().toISOString() });
    return jsonResponse(row ?? null);
  }

  // GET (list / search / get-one)
  let rows = store.slice();
  const id = eqValue(params, "id");
  if (id) rows = rows.filter((x) => x.id === id);
  const category = eqValue(params, "category");
  if (category) rows = rows.filter((x) => x.category === category);
  const type = eqValue(params, "type");
  if (type) rows = rows.filter((x) => x.type === type);
  const search = params.get("search");
  if (search) {
    const terms = websearchTerms(search);
    rows = rows.filter((row) => {
      const text = searchable(row);
      return terms.every((t) => text.includes(t));
    });
  }
  // Newest-first, matching `.order('created_at', { ascending:false })`.
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  // Both list and `.maybeSingle()` receive an ARRAY (maybeSingle picks [0]).
  return jsonResponse(rows);
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input && input.url;
  const opts = init || (typeof input === "object" ? input : undefined) || {};

  if (typeof url === "string") {
    if (url.includes("public-keys.auth.elb.")) {
      return new Response(readPem(), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.includes("/rest/v1/templates")) {
      return handleTemplates(new URL(url), opts);
    }
  }

  return realFetch(input, init);
};
