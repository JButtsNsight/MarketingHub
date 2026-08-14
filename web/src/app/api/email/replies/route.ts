import { headers } from "next/headers";
import { AuthError, requireUser } from "@/lib/auth";
import {
  BisonApiError,
  REPLY_FOLDERS,
  REPLY_STATUS_FILTERS,
  listReplies,
  readConnection,
  type BisonReplyFolder,
  type BisonReplyStatusFilter,
} from "@/lib/email/bison";

/**
 * EmailBison replies proxy (Email Campaign Center). Marketing tier; the
 * browser never holds the API key — this route reads the runtime secret and
 * calls the instance server-side. Not-connected is a NORMAL state (200 with
 * connected:false) so the page renders its connect card without error noise.
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(await headers(), MARKETING_GROUP);
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  let conn;
  try {
    conn = await readConnection();
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
  if (!conn) return Response.json({ connected: false });

  const url = new URL(req.url);
  const rawFolder = url.searchParams.get("folder") ?? "";
  const folder = (REPLY_FOLDERS as readonly string[]).includes(rawFolder)
    ? (rawFolder as BisonReplyFolder)
    : "inbox";
  const rawStatus = url.searchParams.get("status") ?? "";
  const status = (REPLY_STATUS_FILTERS as readonly string[]).includes(rawStatus)
    ? (rawStatus as BisonReplyStatusFilter)
    : undefined;
  const rawPage = Number(url.searchParams.get("page") ?? "1");
  const page =
    Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 10_000 ? rawPage : 1;

  try {
    const { replies, meta } = await listReplies(conn, { folder, status, page });
    return Response.json({ connected: true, replies, meta });
  } catch (err) {
    if (err instanceof BisonApiError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
