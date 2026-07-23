import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { getBoardMeta, type MondayColumn } from "@/lib/monday/boards";
import { MondayConfigError, mondayGraphQL } from "@/lib/monday/client";
import { normalizeUsPhone } from "@/lib/sms/phone";
import { CampaignCreateInputSchema } from "@/lib/sms/schema";

/**
 * Board preview for the campaign-creation form: paste a board (id or URL) and
 * get back its columns, the suggested phone column, and a classified sample
 * of the FIRST items_page only. The preview is advisory — campaign creation
 * refetches every page with the user's final column choice.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Monday's items_page maximum (mirrors the full fetch in lib/monday/boards). */
const PAGE_LIMIT = 500;
/** Preview rows returned to the browser; counts still cover the whole page. */
const SAMPLE_LIMIT = 25;

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** `{board}` accepts the same raw-id-or-URL input as campaign creation. */
const BodySchema = z.object({
  board: CampaignCreateInputSchema.shape.mondayBoardId,
});

/** First page only — no cursor chasing here, by design. */
const FIRST_PAGE_QUERY = `
  query BoardPreviewFirstPage($boardIds: [ID!], $columnIds: [String!]) {
    boards(ids: $boardIds) {
      items_page(limit: ${PAGE_LIMIT}) {
        cursor
        items {
          id
          name
          column_values(ids: $columnIds) {
            id
            text
            ... on PhoneValue {
              phone
              country_short_name
            }
          }
        }
      }
    }
  }
`;

interface PreviewItem {
  id: string | number;
  name: string;
  column_values?: Array<{
    id: string;
    text?: string | null;
    phone?: string | null;
    country_short_name?: string | null;
  }> | null;
}

interface SampleRow {
  name: string;
  phoneE164: string | null;
  reason: "ok" | "invalid" | "duplicate";
}

interface PageCounts {
  fetched: number;
  valid: number;
  invalid: number;
  duplicate: number;
}

/**
 * Classify one page of items the way creation-time prepareRecipients will:
 * no usable US phone → invalid, phone already seen → duplicate, else ok.
 */
function classifyPage(items: PreviewItem[], phoneColumnId: string) {
  const counts: PageCounts = {
    fetched: items.length,
    valid: 0,
    invalid: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  const rows: SampleRow[] = items.map((item) => {
    const cell = (item.column_values ?? []).find((c) => c.id === phoneColumnId);
    const rawPhone = (cell?.phone ?? cell?.text ?? "").trim();
    const phoneE164 = rawPhone
      ? normalizeUsPhone(rawPhone, cell?.country_short_name ?? undefined)
      : null;

    let reason: SampleRow["reason"];
    if (!phoneE164) {
      reason = "invalid";
    } else if (seen.has(phoneE164)) {
      reason = "duplicate";
    } else {
      seen.add(phoneE164);
      reason = "ok";
    }
    counts[reason === "ok" ? "valid" : reason] += 1;
    return { name: item.name, phoneE164, reason };
  });

  return { sample: rows.slice(0, SAMPLE_LIMIT), pageCounts: counts };
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const boardId = parsed.data.board;

  try {
    const meta = await getBoardMeta(boardId);
    if (!meta) {
      return Response.json({ error: "Board not found" }, { status: 404 });
    }

    const phoneColumns: MondayColumn[] = meta.columns.filter(
      (c) => c.type === "phone",
    );
    const suggestedPhoneColumnId = phoneColumns[0]?.id ?? null;

    // Without a phone-type column there is nothing sensible to sample; the
    // form still renders the column picker from `columns`.
    let sample: SampleRow[] = [];
    let pageCounts: PageCounts = {
      fetched: 0,
      valid: 0,
      invalid: 0,
      duplicate: 0,
    };
    if (suggestedPhoneColumnId) {
      const data = await mondayGraphQL<{
        boards?: Array<{
          items_page?: { cursor: string | null; items?: PreviewItem[] | null };
        }> | null;
      }>(FIRST_PAGE_QUERY, {
        boardIds: [boardId],
        columnIds: [suggestedPhoneColumnId],
      });
      const items = data.boards?.[0]?.items_page?.items ?? [];
      ({ sample, pageCounts } = classifyPage(items, suggestedPhoneColumnId));
    }

    return Response.json({
      boardId: meta.id,
      boardName: meta.name,
      columns: meta.columns,
      phoneColumns,
      suggestedPhoneColumnId,
      sample,
      pageCounts,
    });
  } catch (err) {
    if (err instanceof MondayConfigError) {
      return Response.json({ error: "monday-not-configured" }, { status: 503 });
    }
    throw err;
  }
}
