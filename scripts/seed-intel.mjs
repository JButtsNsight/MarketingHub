#!/usr/bin/env node
// Seed competitor-intel sources + documents from a JSON file, through the
// preview SSM tunnel (PREVIEW_AUTH satisfies the marketing gate — no header needed).
//
// Usage: node scripts/seed-intel.mjs <seed.json> [baseUrl]
//   seed.json: { sources: [{name, kind, url?, notes?}], documents: [{source, title, content}] }
//   baseUrl defaults to http://localhost:8080
//
// Idempotent: sources matched by name, documents by (source, title) — existing
// entries are skipped, so re-runs only add what's missing.

const [, , seedPath, baseUrl = 'http://localhost:8080'] = process.argv;
if (!seedPath) {
  console.error('usage: node scripts/seed-intel.mjs <seed.json> [baseUrl]');
  process.exit(1);
}

const { readFile } = await import('node:fs/promises');
const seed = JSON.parse(await readFile(seedPath, 'utf8'));

async function api(path, init) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const existing = await api('/api/intel/sources');
const sourceIdByName = new Map(
  (existing.sources ?? existing ?? []).map((s) => [s.name, s.id]),
);

let createdSources = 0;
for (const s of seed.sources) {
  if (sourceIdByName.has(s.name)) continue;
  const body = { name: s.name, kind: s.kind, ...(s.url ? { url: s.url } : {}), ...(s.notes ? { notes: s.notes } : {}) };
  const created = await api('/api/intel/sources', { method: 'POST', body: JSON.stringify(body) });
  const id = created.source?.id ?? created.id;
  if (!id) throw new Error(`no id in source-create response for "${s.name}"`);
  sourceIdByName.set(s.name, id);
  createdSources += 1;
}

let createdDocs = 0;
let skippedDocs = 0;
for (const d of seed.documents) {
  const sourceId = sourceIdByName.get(d.source);
  if (!sourceId) throw new Error(`document "${d.title}" references unknown source "${d.source}"`);
  const docs = await api(`/api/intel/documents?sourceId=${sourceId}`);
  const list = docs.documents ?? docs ?? [];
  if (list.some((x) => x.title === d.title)) {
    skippedDocs += 1;
    continue;
  }
  await api('/api/intel/documents', {
    method: 'POST',
    body: JSON.stringify({ sourceId, title: d.title, content: d.content }),
  });
  createdDocs += 1;
}

console.log(
  `sources: +${createdSources} (${sourceIdByName.size} total) | documents: +${createdDocs}, ${skippedDocs} already present`,
);
