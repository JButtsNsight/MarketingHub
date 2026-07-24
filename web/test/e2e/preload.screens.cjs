/**
 * Screenshot-harness preload. Loaded AFTER preload.cjs (which installs the ALB
 * public-key + in-memory /rest/v1/templates shims and sets global.fetch). This
 * wraps that fetch to ALSO answer Supabase Storage list calls with an
 * illustrative object listing, so the /storage page renders with content
 * instead of erroring against the (absent) real Storage API.
 *
 * Dev/demo tooling only — not part of `npm test` or the committed e2e run.
 */
"use strict";

const prev = globalThis.fetch;

// Illustrative bucket root: template-id "folders" (id === null) + a couple files.
const ROOT_LISTING = [
  { name: "0f2c8b6a-1e4d-4b7a-9c31-a1b2c3d4e5f6", id: null, updated_at: "2026-07-06T10:12:00Z", metadata: null },
  { name: "3a9e1d70-7c2b-4f55-8e0a-9b8c7d6e5f40", id: null, updated_at: "2026-07-06T10:31:00Z", metadata: null },
  { name: "b7d4f210-55aa-49cc-8f21-0a1b2c3d4e5f", id: null, updated_at: "2026-07-06T11:02:00Z", metadata: null },
  { name: "spring-sale.html", id: "obj-1", updated_at: "2026-07-06T10:12:00Z", metadata: { size: 4096, mimetype: "text/html" } },
  { name: "welcome.eml", id: "obj-2", updated_at: "2026-07-06T10:31:00Z", metadata: { size: 2048, mimetype: "message/rfc822" } },
];

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input && input.url;
  if (typeof url === "string" && url.includes("/storage/v1/object/list/")) {
    return new Response(JSON.stringify(ROOT_LISTING), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return prev(input, init);
};
