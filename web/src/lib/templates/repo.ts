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
/** Private Supabase Storage bucket holding the raw template files. */
const BUCKET = "campaign-templates";
/** Signed-URL lifetime (seconds) for template-file downloads. */
const SIGNED_URL_TTL = 60 * 5;

/** Minimal identity needed to stamp ownership; the fuller Cognito user
 * (Phase 3 `getUser`) is structurally compatible. */
export interface TemplateCreator {
  email: string;
}

export interface ListFilters {
  category?: string;
  type?: TemplateType;
}

/** The raw file to persist alongside a template's metadata. */
export interface TemplateFile {
  filename: string;
  content: string | ArrayBuffer | Uint8Array | Blob;
  contentType?: string;
}

/** PostgREST query builder scoped to marketinghub.templates. */
function templates() {
  return getServiceClient().schema(SCHEMA).from(TABLE);
}

function fail(op: string, message: string): never {
  throw new Error(`[templates] ${op} failed: ${message}`);
}

/**
 * Reduce an arbitrary upload filename to a storage-safe basename: strip any
 * directory components, allow only `[A-Za-z0-9._-]`, collapse runs of `_`, and
 * never return empty. Prevents path traversal in the object key.
 */
function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/**
 * Create a template row. Re-validates+normalizes with the zod schema at the
 * boundary (idempotent) and stamps `created_by` from the authed user's email.
 */
export async function createTemplate(
  input: TemplateInput,
  user: TemplateCreator,
  file?: TemplateFile,
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
  let template = data as Template;

  // If a raw file accompanied the template, store it under <id>/<safe-filename>
  // in the private Storage bucket and persist the resulting path on the row.
  if (file) {
    const storagePath = `${template.id}/${safeFilename(file.filename)}`;
    const { error: uploadError } = await getServiceClient()
      .storage.from(BUCKET)
      .upload(storagePath, file.content, {
        contentType: file.contentType,
        upsert: true,
      });
    if (uploadError) fail("upload", uploadError.message);

    const { data: updated, error: updateError } = await templates()
      .update({ storage_path: storagePath })
      .eq("id", template.id)
      .select()
      .single();
    if (updateError) fail("update-storage-path", updateError.message);
    template = updated as Template;
  }

  return template;
}

/**
 * Return a short-lived signed download URL for a template's stored file, or
 * null if the template does not exist or has no associated file.
 */
export async function getTemplateFile(
  id: string,
): Promise<{ signedUrl: string } | null> {
  const template = await getTemplate(id);
  if (!template || !template.storage_path) return null;

  const { data, error } = await getServiceClient()
    .storage.from(BUCKET)
    .createSignedUrl(template.storage_path, SIGNED_URL_TTL);
  if (error) fail("signed-url", error.message);
  return { signedUrl: (data as { signedUrl: string }).signedUrl };
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
