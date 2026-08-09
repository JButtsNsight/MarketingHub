import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { readJsonBodyBounded } from "@/lib/jsonBody";
import { getUserClient } from "@/lib/supabase";
import {
  createDocument,
  getSource,
  listDocumentsBySource,
  NotProvisionedError,
} from "@/lib/intel/repo";
import { DocumentCreateInputSchema } from "@/lib/intel/schema";

/**
 * Competitor-intel documents collection. Ingestion is PASTE-TEXT ONLY this
 * wave — no URL fetching exists anywhere in this module (SSRF-guarded
 * fetching is an honest follow-up). POST inserts the pasted document; the DB
 * trigger enqueues the embedding job — nothing synchronous happens here.
 * GET lists a source's documents (summaries; ?sourceId= required).
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/**
 * Byte cap on the POST envelope, enforced BEFORE parsing (readJsonBodyBounded
 * — a bare req.json() would buffer a multi-GB body into memory before Zod
 * ever rejects it, an OOM lever against the shared 1 GiB app container).
 * Sized above the 500k-char content ceiling even at 4-byte UTF-8 code points
 * (500k × 4 = 2 MiB) plus title/JSON overhead, so no legitimate paste is
 * ever 413'd while the stream cap stays a hard bound.
 */
const DOCUMENT_JSON_BODY_LIMIT_BYTES = 3 * 1024 * 1024;

const UuidSchema = z.string().uuid();

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Honest 503 while the competitor_intel substrate is not applied yet. */
function notProvisionedResponse(err: NotProvisionedError): Response {
  return Response.json(
    { error: "intel-not-provisioned", message: err.message },
    { status: 503 },
  );
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  // Bounded read BEFORE parse (413 over the cap / 400 on invalid JSON).
  const read = await readJsonBodyBounded(req, DOCUMENT_JSON_BODY_LIMIT_BYTES);
  if (!read.ok) return read.response;

  const parsed = DocumentCreateInputSchema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = await getUserClient(user);
  try {
    // Friendly 404 instead of a raw FK violation when the source is gone.
    const source = await getSource(parsed.data.sourceId, db);
    if (!source) {
      return Response.json({ error: "Source not found" }, { status: 404 });
    }

    const document = await createDocument(parsed.data, db);
    return Response.json({ id: document.id, document }, { status: 201 });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const url = new URL(req.url);
  const sourceId = url.searchParams.get("sourceId");
  if (!UuidSchema.safeParse(sourceId).success) {
    return Response.json(
      { error: "sourceId query param (UUID) is required" },
      { status: 400 },
    );
  }

  try {
    const documents = await listDocumentsBySource(sourceId as string, db);
    return Response.json({ documents });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}
