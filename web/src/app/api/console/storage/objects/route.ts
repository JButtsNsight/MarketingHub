import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  bucketExists,
  deleteObjects,
  isSafePath,
  listBucket,
  listBuckets,
  moveObject,
  uploadObject,
  UPLOAD_MAX_BYTES,
} from "@/lib/console/storage";

/**
 * Storage browser object operations, gated on the platform section:
 *
 * - GET    ?bucket&prefix          → one level of the tree (+ bucket list)
 * - POST   multipart {bucket, prefix, file} → upload (never overwrites —
 *          delete first; the console makes replacement an explicit act)
 * - PATCH  {bucket, from, to}      → rename/move
 * - DELETE {bucket, paths[]}       → remove objects
 *
 * Every verb validates the bucket against the live bucket list and every
 * path against the traversal-safe shape before the Storage API sees it.
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Storage API failures are user feedback in a browser UI — surface as 400. */
async function storageAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:storage]")) {
      return Response.json(
        { error: err.message.replace(/^\[console:storage\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const bucket = url.searchParams.get("bucket") ?? "";
  const prefix = url.searchParams.get("prefix") ?? "";

  if (prefix && !isSafePath(prefix)) {
    return Response.json({ error: "invalid prefix" }, { status: 400 });
  }

  const buckets = await listBuckets();
  if (bucket && !buckets.some((b) => b.name === bucket)) {
    return Response.json({ error: "Bucket not found" }, { status: 404 });
  }

  const entries = bucket
    ? await storageAttempt(() => listBucket(prefix, bucket))
    : [];
  if (entries instanceof Response) return entries;

  return Response.json({ buckets, entries });
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const bucket = String(form.get("bucket") ?? "");
  const prefix = String(form.get("prefix") ?? "");
  const file = form.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "file is required" }, { status: 400 });
  }
  if (file.size === 0 || file.size > UPLOAD_MAX_BYTES) {
    return Response.json(
      { error: `File must be 1 byte – ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB` },
      { status: 413 },
    );
  }

  const path = prefix ? `${prefix}/${file.name}` : file.name;
  if (!isSafePath(path)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }
  if (!bucket || !(await bucketExists(bucket))) {
    return Response.json({ error: "Bucket not found" }, { status: 404 });
  }

  const result = await storageAttempt(async () => {
    await uploadObject(
      bucket,
      path,
      await file.arrayBuffer(),
      file.type || "application/octet-stream",
    );
    return { path };
  });
  if (result instanceof Response) return result;
  return Response.json({ uploaded: result.path }, { status: 201 });
}

const MoveBodySchema = z.object({
  bucket: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

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
  const parsed = MoveBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { bucket, from, to } = parsed.data;
  if (!isSafePath(from) || !isSafePath(to)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }
  if (!(await bucketExists(bucket))) {
    return Response.json({ error: "Bucket not found" }, { status: 404 });
  }

  const result = await storageAttempt(() => moveObject(bucket, from, to));
  if (result instanceof Response) return result;
  return Response.json({ moved: to });
}

const DeleteBodySchema = z.object({
  bucket: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(200),
});

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
  if (!parsed.data.paths.every(isSafePath)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }
  if (!(await bucketExists(parsed.data.bucket))) {
    return Response.json({ error: "Bucket not found" }, { status: 404 });
  }

  const deleted = await storageAttempt(() =>
    deleteObjects(parsed.data.bucket, parsed.data.paths),
  );
  if (deleted instanceof Response) return deleted;
  return Response.json({ deleted });
}
