import { headers } from "next/headers";
import { AuthError, requireUser } from "@/lib/auth";
import { requireAdminApi } from "@/lib/requireAdminUser";
import {
  BisonApiError,
  isProvisioned,
  normalizeBaseUrl,
  readConnection,
  validateConnection,
  writeConnection,
} from "@/lib/email/bison";

/**
 * EmailBison connection API (Email Campaign Center).
 * GET    — connection status (marketing tier; never leaks the API key).
 * POST   — connect: validate the pasted instance URL + token against the live
 *          EmailBison API, then persist to the runtime secret (admin-only,
 *          fresh live-group check — this is a credential write).
 * DELETE — disconnect (admin-only, fresh check).
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

export async function GET(): Promise<Response> {
  try {
    await requireUser(await headers(), MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  if (!isProvisioned()) {
    return Response.json({ provisioned: false, connected: false });
  }
  try {
    const conn = await readConnection();
    return Response.json(
      conn
        ? {
            provisioned: true,
            connected: true,
            baseUrl: conn.baseUrl,
            workspaceName: conn.workspaceName,
          }
        : { provisioned: true, connected: false },
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "emailbison.connection.read-failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return Response.json(
      { error: "could not read the EmailBison connection" },
      { status: 502 },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  let adminEmail: string;
  try {
    adminEmail = (await requireAdminApi(await headers(), { fresh: true })).email;
  } catch (err) {
    return authErrorResponse(err);
  }
  if (!isProvisioned()) {
    return Response.json(
      { error: "EmailBison secret not provisioned on this deployment" },
      { status: 409 },
    );
  }
  let body: { baseUrl?: unknown; apiKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const baseUrl = normalizeBaseUrl(
    typeof body.baseUrl === "string" ? body.baseUrl : "",
  );
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!baseUrl) {
    return Response.json(
      { error: "instance URL must be a valid https host" },
      { status: 400 },
    );
  }
  if (apiKey === "" || apiKey.length > 512) {
    return Response.json({ error: "API token is required" }, { status: 400 });
  }
  try {
    const { workspaceName } = await validateConnection({ baseUrl, apiKey });
    await writeConnection({ baseUrl, apiKey, workspaceName });
    console.log(
      JSON.stringify({
        evt: "emailbison.connected",
        by: adminEmail,
        baseUrl,
        workspaceName,
      }),
    );
    return Response.json({ connected: true, baseUrl, workspaceName });
  } catch (err) {
    if (err instanceof BisonApiError) {
      // Upstream refused the credentials/host — the operator's to fix.
      return Response.json({ error: err.message }, { status: 422 });
    }
    console.error(
      JSON.stringify({
        evt: "emailbison.connect-failed",
        by: adminEmail,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return Response.json(
      { error: "could not store the EmailBison connection" },
      { status: 502 },
    );
  }
}

export async function DELETE(): Promise<Response> {
  let adminEmail: string;
  try {
    adminEmail = (await requireAdminApi(await headers(), { fresh: true })).email;
  } catch (err) {
    return authErrorResponse(err);
  }
  try {
    await writeConnection(null);
    console.log(
      JSON.stringify({ evt: "emailbison.disconnected", by: adminEmail }),
    );
    return Response.json({ connected: false });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "emailbison.disconnect-failed",
        by: adminEmail,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return Response.json(
      { error: "could not clear the EmailBison connection" },
      { status: 502 },
    );
  }
}
