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
    // weighting over name/tags/category/body
    expect(sql).toMatch(/setweight\(to_tsvector\('english',\s*coalesce\(name,\s*''\)\),\s*'A'\)/i);
    expect(sql).toMatch(/array_to_string\(tags,\s*'\s*'\)/i);
    expect(sql).toMatch(/setweight\(to_tsvector\('english',\s*coalesce\(body,\s*''\)\),\s*'C'\)/i);
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
});
