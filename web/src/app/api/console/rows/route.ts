import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  deleteRows,
  getEditorTable,
  getRows,
  insertRow,
  isFilterOp,
  isReadOnlyTable,
  updateRow,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type RowFilter,
} from "@/lib/console/tables";

/**
 * Table Editor row CRUD, gated on the platform section. Every verb
 * re-validates the target against LIVE introspection (unknown schema/table →
 * 404; unknown column → 400) before PostgREST sees anything, and Postgres
 * errors (constraint violations, bad casts) surface as 400s with the real
 * message — that is the Studio behavior for an editor.
 *
 * PK-less tables are browse-only: update/delete require addressing rows by
 * their FULL primary key, so those verbs 409 without one.
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Postgres-level failures are user errors in an editor — surface as 400. */
async function editorAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:tables]")) {
      return Response.json(
        { error: err.message.replace(/^\[console:tables\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

const TargetSchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
});

const FilterSchema = z.object({
  column: z.string().min(1),
  op: z.string().refine(isFilterOp, { message: "unknown filter operator" }),
  value: z.string(),
});

const PostBodySchema = TargetSchema.extend({
  values: z.record(z.unknown()),
});

const PatchBodySchema = TargetSchema.extend({
  pk: z.record(z.unknown()),
  patch: z.record(z.unknown()).refine((p) => Object.keys(p).length > 0, {
    message: "patch must set at least one column",
  }),
});

const DeleteBodySchema = TargetSchema.extend({
  keys: z.array(z.record(z.unknown())).min(1).max(MAX_PAGE_SIZE),
});

function knownColumns(
  meta: { columns: Array<{ name: string }> },
  names: string[],
): boolean {
  const known = new Set(meta.columns.map((c) => c.name));
  return names.every((n) => known.has(n));
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const target = TargetSchema.safeParse({
    schema: url.searchParams.get("schema") ?? "",
    table: url.searchParams.get("table") ?? "",
  });
  if (!target.success) {
    return Response.json({ error: "schema and table are required" }, { status: 400 });
  }

  const meta = await getEditorTable(target.data.schema, target.data.table);
  if (!meta) {
    return Response.json({ error: "Table not found" }, { status: 404 });
  }

  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);
  const pageSize = Math.min(
    Math.max(1, Number(url.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  const sortColumn = url.searchParams.get("sort");
  const sort = sortColumn
    ? { column: sortColumn, ascending: url.searchParams.get("dir") !== "desc" }
    : null;

  let filters: RowFilter[] = [];
  const rawFilters = url.searchParams.get("filters");
  if (rawFilters) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFilters);
    } catch {
      return Response.json({ error: "filters must be JSON" }, { status: 400 });
    }
    const checked = z.array(FilterSchema).max(20).safeParse(parsed);
    if (!checked.success) {
      return Response.json(
        { error: "Validation failed", issues: checked.error.issues },
        { status: 400 },
      );
    }
    filters = checked.data as RowFilter[];
  }

  const referenced = [...(sort ? [sort.column] : []), ...filters.map((f) => f.column)];
  if (!knownColumns(meta, referenced)) {
    return Response.json({ error: "Unknown column in sort/filter" }, { status: 400 });
  }

  const result = await editorAttempt(() => getRows(meta, { page, pageSize, sort, filters }));
  if (result instanceof Response) return result;
  return Response.json({ ...result, meta: { schema: meta.schema, table: meta.name } });
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PostBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const meta = await getEditorTable(parsed.data.schema, parsed.data.table);
  if (!meta) {
    return Response.json({ error: "Table not found" }, { status: 404 });
  }
  if (isReadOnlyTable(meta.schema, meta.name)) {
    return Response.json(
      { error: "This table is read-only in the console." },
      { status: 403 },
    );
  }
  if (!knownColumns(meta, Object.keys(parsed.data.values))) {
    return Response.json({ error: "Unknown column in values" }, { status: 400 });
  }

  const row = await editorAttempt(() => insertRow(meta, parsed.data.values));
  if (row instanceof Response) return row;
  return Response.json({ row }, { status: 201 });
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PatchBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const meta = await getEditorTable(parsed.data.schema, parsed.data.table);
  if (!meta) {
    return Response.json({ error: "Table not found" }, { status: 404 });
  }
  if (isReadOnlyTable(meta.schema, meta.name)) {
    return Response.json(
      { error: "This table is read-only in the console." },
      { status: 403 },
    );
  }
  if (meta.primaryKeys.length === 0) {
    return Response.json(
      { error: "Table has no primary key — rows cannot be updated" },
      { status: 409 },
    );
  }
  if (
    !knownColumns(meta, Object.keys(parsed.data.patch)) ||
    Object.keys(parsed.data.pk).sort().join(",") !==
      [...meta.primaryKeys].sort().join(",")
  ) {
    return Response.json(
      { error: "Unknown column in patch or incomplete primary key" },
      { status: 400 },
    );
  }

  const row = await editorAttempt(() =>
    updateRow(meta, parsed.data.pk, parsed.data.patch),
  );
  if (row instanceof Response) return row;
  if (!row) {
    return Response.json({ error: "Row not found" }, { status: 404 });
  }
  return Response.json({ row });
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = DeleteBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const meta = await getEditorTable(parsed.data.schema, parsed.data.table);
  if (!meta) {
    return Response.json({ error: "Table not found" }, { status: 404 });
  }
  if (isReadOnlyTable(meta.schema, meta.name)) {
    return Response.json(
      { error: "This table is read-only in the console." },
      { status: 403 },
    );
  }
  if (meta.primaryKeys.length === 0) {
    return Response.json(
      { error: "Table has no primary key — rows cannot be deleted" },
      { status: 409 },
    );
  }
  const shape = [...meta.primaryKeys].sort().join(",");
  if (parsed.data.keys.some((k) => Object.keys(k).sort().join(",") !== shape)) {
    return Response.json({ error: "Incomplete primary key" }, { status: 400 });
  }

  const deleted = await editorAttempt(() => deleteRows(meta, parsed.data.keys));
  if (deleted instanceof Response) return deleted;
  return Response.json({ deleted });
}
