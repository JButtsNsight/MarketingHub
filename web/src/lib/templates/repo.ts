import "server-only";

import { getServiceClient } from "../supabase";
import {
  TemplateInputSchema,
  type Template,
  type TemplateInput,
  type TemplateType,
} from "./schema";

const SCHEMA = "marketinghub";
const TABLE = "templates";

/** Minimal identity needed to stamp ownership; the fuller Cognito user
 * (Phase 3 `getUser`) is structurally compatible. */
export interface TemplateCreator {
  email: string;
}

export interface ListFilters {
  category?: string;
  type?: TemplateType;
}

/** PostgREST query builder scoped to marketinghub.templates. */
function templates() {
  return getServiceClient().schema(SCHEMA).from(TABLE);
}

function fail(op: string, message: string): never {
  throw new Error(`[templates] ${op} failed: ${message}`);
}

/**
 * Create a template row. Re-validates+normalizes with the zod schema at the
 * boundary (idempotent) and stamps `created_by` from the authed user's email.
 */
export async function createTemplate(
  input: TemplateInput,
  user: TemplateCreator,
): Promise<Template> {
  const parsed = TemplateInputSchema.parse(input);
  const row = {
    name: parsed.name,
    type: parsed.type,
    category: parsed.category,
    tags: parsed.tags,
    subject: parsed.subject ?? null,
    body: parsed.body,
    created_by: user.email,
  };

  const { data, error } = await templates().insert(row).select().single();
  if (error) fail("create", error.message);
  return data as Template;
}

/** List templates (newest first), optionally filtered by category and/or type. */
export async function listTemplates(
  filters: ListFilters = {},
): Promise<Template[]> {
  let query = templates()
    .select("*")
    .order("created_at", { ascending: false });
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.type) query = query.eq("type", filters.type);

  const { data, error } = await query;
  if (error) fail("list", error.message);
  return (data ?? []) as Template[];
}

/**
 * Full-text search over the generated `search` tsvector via PostgREST
 * `websearch_to_tsquery`. A blank query falls back to a plain list so the
 * search box degrades gracefully to browse. Category/type filters still apply.
 */
export async function searchTemplates(
  q: string,
  filters: ListFilters = {},
): Promise<Template[]> {
  const term = q.trim();
  if (!term) return listTemplates(filters);

  let query = templates()
    .select("*")
    .textSearch("search", term, { type: "websearch" });
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.type) query = query.eq("type", filters.type);

  const { data, error } = await query;
  if (error) fail("search", error.message);
  return (data ?? []) as Template[];
}

/** Fetch a single template by id, or null if it does not exist. */
export async function getTemplate(id: string): Promise<Template | null> {
  const { data, error } = await templates()
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) fail("get", error.message);
  return (data as Template) ?? null;
}
