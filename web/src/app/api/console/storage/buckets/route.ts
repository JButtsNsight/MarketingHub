import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  CAMPAIGN_BUCKET,
  bucketExists,
  createBucket,
  deleteBucket,
  emptyBucket,
  listBuckets,
  updateBucket,
} from "@/lib/console/storage";

/**
 * Bucket management, gated on the platform section:
 *
 * - GET                                      → all buckets with their settings
 * - POST   {name, public?, fileSizeLimit?, allowedMimeTypes?} → create
 * - PATCH  {name, public, fileSizeLimit?, allowedMimeTypes?}  → update settings
 *          (the Storage API replaces visibility on update, so `public` is
 *          always explicit)
 * - DELETE {name, action?, confirm}          → delete (default) or empty
 *
 * Destructive verbs demand `confirm` echoing the bucket name so the UI's
 * confirm modal is enforced server-side too — a bare {name} can never wipe a
 * bucket. Zod validates shape here; the lib re-validates semantics (name
 * charset, size-limit range, mime shapes) before the Storage API sees them.
 *
 * Runbook §7 invariant, enforced here (not just policy): the app's template
 * bucket (CAMPAIGN_BUCKET) can never be made public, emptied, or deleted —
 * templates/repo.ts depends on it, and its files must stay signed-URL-only.
 */

function campaignBucketRefusal(what: string): Response {
  return Response.json(
    { error: `The "${CAMPAIGN_BUCKET}" bucket ${what} — the app depends on it` },
    { status: 403 },
  );
}

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

async function jsonBody(req: Request): Promise<unknown | Response> {
  try {
    return await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const buckets = await storageAttempt(() => listBuckets());
  if (buckets instanceof Response) return buckets;
  return Response.json({ buckets });
}

const SettingsShape = {
  fileSizeLimit: z.number().nullable().optional(),
  allowedMimeTypes: z.array(z.string()).nullable().optional(),
};

const CreateBodySchema = z.object({
  name: z.string().min(1).max(100),
  public: z.boolean().optional(),
  ...SettingsShape,
});

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const payload = await jsonBody(req);
  if (payload instanceof Response) return payload;
  const parsed = CreateBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, public: isPublic, fileSizeLimit, allowedMimeTypes } = parsed.data;
  if (name === CAMPAIGN_BUCKET && isPublic) {
    return campaignBucketRefusal("must stay private");
  }
  const result = await storageAttempt(() =>
    createBucket(name, { public: isPublic, fileSizeLimit, allowedMimeTypes }),
  );
  if (result instanceof Response) return result;
  return Response.json({ created: name }, { status: 201 });
}

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(100),
  public: z.boolean(),
  ...SettingsShape,
});

export async function PATCH(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const payload = await jsonBody(req);
  if (payload instanceof Response) return payload;
  const parsed = UpdateBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, public: isPublic, fileSizeLimit, allowedMimeTypes } = parsed.data;
  if (name === CAMPAIGN_BUCKET && isPublic) {
    return campaignBucketRefusal("must stay private");
  }
  if (!(await bucketExists(name))) {
    return Response.json({ error: "Bucket not found" }, { status: 404 });
  }

  const result = await storageAttempt(() =>
    updateBucket(name, { public: isPublic, fileSizeLimit, allowedMimeTypes }),
  );
  if (result instanceof Response) return result;
  return Response.json({ updated: name });
}

const DeleteBodySchema = z.object({
  name: z.string().min(1).max(100),
  action: z.enum(["delete", "empty"]).optional(),
  /** Must echo `name` — the server-side half of the confirm modal. */
  confirm: z.string(),
});

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const payload = await jsonBody(req);
  if (payload instanceof Response) return payload;
  const parsed = DeleteBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, action, confirm } = parsed.data;
  if (name === CAMPAIGN_BUCKET) {
    return campaignBucketRefusal("cannot be emptied or deleted");
  }
  if (confirm !== name) {
    return Response.json(
      { error: "confirm must match the bucket name exactly" },
      { status: 400 },
    );
  }
  if (!(await bucketExists(name))) {
    return Response.json({ error: "Bucket not found" }, { status: 404 });
  }

  if (action === "empty") {
    const result = await storageAttempt(() => emptyBucket(name));
    if (result instanceof Response) return result;
    return Response.json({ emptied: name });
  }

  // Upstream refuses to delete a non-empty bucket — that surfaces as 400.
  const result = await storageAttempt(() => deleteBucket(name));
  if (result instanceof Response) return result;
  return Response.json({ deleted: name });
}
