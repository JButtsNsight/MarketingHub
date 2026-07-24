import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('2026-07-05-templates.sql migration', () => {
  const sql = read('sql/2026-07-05-templates.sql');

  test('is idempotent (create ... if not exists) and never drops the table', () => {
    expect(sql).toMatch(/create schema if not exists marketinghub/i);
    expect(sql).toMatch(/create table if not exists marketinghub\.templates/i);
    // never destructive
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+schema/i);
  });

  test('defines a generated stored tsvector search column with weighted sources', () => {
    expect(sql).toMatch(/search\s+tsvector\s+generated always as/i);
    expect(sql).toMatch(/stored/i);
    // The column delegates to an IMMUTABLE wrapper (generated-column
    // expressions must be immutable; bare to_tsvector('english',...) is only
    // STABLE) that weights name(A) / tags+category(B) / body(C).
    expect(sql).toMatch(/create or replace function marketinghub\.templates_search[\s\S]*immutable/i);
    expect(sql).toMatch(/setweight\(to_tsvector\('english'::regconfig,\s*coalesce\(p_name,\s*''\)\),\s*'A'\)/i);
    expect(sql).toMatch(/array_to_string\(coalesce\(p_tags,\s*'\{\}'::text\[\]\),\s*'\s*'\)/i);
    expect(sql).toMatch(/setweight\(to_tsvector\('english'::regconfig,\s*coalesce\(p_body,\s*''\)\),\s*'C'\)/i);
    expect(sql).toMatch(/generated always as\s*\(\s*marketinghub\.templates_search\(name,\s*tags,\s*category,\s*body\)\s*\)\s*stored/i);
  });

  test('creates a GIN index on the search tsvector', () => {
    expect(sql).toMatch(/create index if not exists templates_search_idx\s+on marketinghub\.templates\s+using gin\s*\(\s*search\s*\)/i);
  });

  test('constrains type to text|email via a check constraint', () => {
    expect(sql).toMatch(/type\s+text\s+not null\s+check\s*\(\s*type\s+in\s*\(\s*'text'\s*,\s*'email'\s*\)\s*\)/i);
  });

  test('creates a GIN index on tags and a btree index on category', () => {
    expect(sql).toMatch(/create index if not exists templates_tags_idx\s+on marketinghub\.templates\s+using gin\s*\(\s*tags\s*\)/i);
    expect(sql).toMatch(/create index if not exists templates_category_idx\s+on marketinghub\.templates\s*\(\s*category\s*\)/i);
  });

  test('documents the private campaign-templates Storage bucket as a comment', () => {
    expect(sql).toMatch(/campaign-templates/);
    // documented as an insert into storage.buckets with public = false
    expect(sql).toMatch(/storage\.buckets/);
    expect(sql).toMatch(/false/);
  });

  test('grants schema + table privileges to service_role (the sole app role)', () => {
    // Without USAGE on the freshly-created schema, service_role hits
    // `42501 permission denied for schema marketinghub` on every PostgREST query.
    expect(sql).toMatch(/grant\s+usage\s+on\s+schema\s+marketinghub\s+to\s+service_role/i);
    expect(sql).toMatch(/grant\s+all(\s+privileges)?\s+on\s+all\s+tables\s+in\s+schema\s+marketinghub\s+to\s+service_role/i);
    // Future tables in the schema also flow to service_role.
    expect(sql).toMatch(/alter\s+default\s+privileges\s+in\s+schema\s+marketinghub[\s\S]*grant\s+all(\s+privileges)?\s+on\s+tables\s+to\s+service_role/i);
  });

  test('enables deny-by-default RLS so the exposed schema passes the RLS gate (spec §12)', () => {
    expect(sql).toMatch(/alter\s+table\s+marketinghub\.templates\s+enable\s+row\s+level\s+security/i);
    expect(sql).toMatch(/alter\s+table\s+marketinghub\.templates\s+force\s+row\s+level\s+security/i);
    // an explicit restrictive deny-all policy for anon/authenticated
    expect(sql).toMatch(/create\s+policy[\s\S]*on\s+marketinghub\.templates/i);
    expect(sql).toMatch(/using\s*\(\s*false\s*\)/i);
  });
});
