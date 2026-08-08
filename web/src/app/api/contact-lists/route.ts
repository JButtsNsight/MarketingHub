import { AuthError, requireUser } from "@/lib/auth";
import { getUserClient } from "@/lib/supabase";
import { MondayConfigError } from "@/lib/monday/client";
import { getBoardMeta } from "@/lib/monday/boards";
import { parseContactSheet, SheetParseError } from "@/lib/contacts/csv";
import {
  createCsvList,
  createMondayList,
  listContactLists,
} from "@/lib/contacts/repo";
import { ListCreateInputSchema } from "@/lib/contacts/schema";

/**
 * Contact-lists collection API. Group-gated SERVER-SIDE on the Cognito
 * `marketing` group; the service-role Supabase client is only reached through
 * the repo. POST accepts either an uploaded sheet (source 'csv' — the file
 * text travels in the JSON body, parsed + classified server-side) or a linked
 * Monday board (source 'monday' — board verified and its name snapshotted).
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Uploaded sheet text cap (~5 MB) — patient lists are thousands of rows. */
const MAX_SHEET_CHARS = 5 * 1024 * 1024;

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  // Per-user client (RLS `authenticated` role) when SUPABASE_JWT_SECRET is
  // set; the service-role fallback otherwise — identical to before.
  const db = await getUserClient(user);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ListCreateInputSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  if (input.source === "csv") {
    if (input.content.length > MAX_SHEET_CHARS) {
      return Response.json(
        { error: "File too large — keep sheets under 5 MB." },
        { status: 413 },
      );
    }

    let sheet;
    try {
      sheet = parseContactSheet(input.content);
    } catch (err) {
      if (err instanceof SheetParseError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // A list nothing could ever send to is a mistake, not a list.
    if (sheet.counts.ok === 0) {
      return Response.json(
        {
          error:
            `No usable contacts: ${sheet.counts.invalid} invalid, ` +
            `${sheet.counts.duplicate} duplicate of ${sheet.counts.total} rows`,
          counts: sheet.counts,
        },
        { status: 400 },
      );
    }

    const list = await createCsvList(
      input.name,
      sheet.contacts,
      { filename: input.filename, content: input.content },
      { email: user.email },
      db,
    );
    return Response.json({ id: list.id, list, counts: sheet.counts }, { status: 201 });
  }

  // source === 'monday' — verify the board and snapshot its name.
  let board;
  try {
    board = await getBoardMeta(input.board);
  } catch (err) {
    if (err instanceof MondayConfigError) {
      return Response.json({ error: "monday-not-configured" }, { status: 503 });
    }
    throw err;
  }
  if (!board) {
    return Response.json({ error: "board-not-found" }, { status: 404 });
  }
  if (!board.columns.some((c) => c.id === input.phoneColumnId)) {
    return Response.json(
      { error: "phoneColumnId is not a column of that board" },
      { status: 400 },
    );
  }

  const list = await createMondayList(
    input.name,
    { id: board.id, name: board.name, phoneColumnId: input.phoneColumnId },
    { email: user.email },
    db,
  );
  return Response.json({ id: list.id, list }, { status: 201 });
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const lists = await listContactLists(db);
  return Response.json({ lists });
}
