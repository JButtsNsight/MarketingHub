import "server-only";

import { normalizeUsPhone } from "../sms/phone";
import { firstNameOf } from "../sms/render";
import { mondayGraphQL } from "./client";

/**
 * Board-shaped helpers over the Monday GraphQL transport: board metadata for
 * the campaign-creation preview, and the full paginated recipient fetch.
 * Errors (`MondayConfigError`/`MondayApiError`) propagate from `client.ts`.
 */

/** Monday's items_page maximum — fewer round trips for patient boards. */
const PAGE_LIMIT = 500;

export interface MondayColumn {
  id: string;
  title: string;
  /** Monday column type, e.g. `phone`, `text` — used to suggest phone columns. */
  type: string;
}

export interface BoardMeta {
  id: string;
  name: string;
  columns: MondayColumn[];
}

/** One board item mapped to campaign-recipient shape (pre-dedupe/suppression). */
export interface BoardRecipient {
  mondayItemId: string;
  name: string;
  firstName: string;
  /** Normalized `+1XXXXXXXXXX`, or null when not a usable US number. */
  phoneE164: string | null;
  /** The raw cell value, kept for audit (`last_error` on skipped rows). */
  rawPhone: string;
  /**
   * Raw timezone cell text (trimmed) when the list configures a Monday
   * timezone column; null when unconfigured or blank. Normalized app-side at
   * campaign creation (`normalizeRecipientZone`) — unknown values fall back
   * to the campaign zone, never a hard reject.
   */
  rawTimezone: string | null;
}

interface ColumnValueNode {
  id: string;
  /** Display text — the only value a `text`-type phone column carries. */
  text?: string | null;
  /** PhoneValue fragment fields (present only on `phone`-type columns). */
  phone?: string | null;
  country_short_name?: string | null;
}

interface ItemNode {
  id: string | number;
  name: string;
  column_values?: ColumnValueNode[] | null;
}

interface ItemsPageNode {
  cursor: string | null;
  items?: ItemNode[] | null;
}

const BOARD_META_QUERY = `
  query BoardMeta($boardIds: [ID!]) {
    boards(ids: $boardIds) {
      id
      name
      columns {
        id
        title
        type
      }
    }
  }
`;

/**
 * Shared item selection: only the chosen columns travel ($columnIds — the
 * phone column, plus the timezone column when configured), with the
 * PhoneValue fragment for real phone columns and `text` as the raw fallback
 * for text-type columns. Non-phone columns (timezone: text/status/dropdown)
 * carry their display value in `text`.
 */
const ITEM_FIELDS = `
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
`;

const FIRST_PAGE_QUERY = `
  query BoardRecipientsFirstPage($boardIds: [ID!], $columnIds: [String!]) {
    boards(ids: $boardIds) {
      items_page(limit: ${PAGE_LIMIT}) {
        cursor
        items {
${ITEM_FIELDS}
        }
      }
    }
  }
`;

const NEXT_PAGE_QUERY = `
  query BoardRecipientsNextPage($cursor: String!, $columnIds: [String!]) {
    next_items_page(cursor: $cursor, limit: ${PAGE_LIMIT}) {
      cursor
      items {
${ITEM_FIELDS}
      }
    }
  }
`;

/**
 * Fetch a board's name and column metadata (for the phone-column picker).
 * Returns null when the board does not exist or the token cannot see it.
 */
export async function getBoardMeta(boardId: string): Promise<BoardMeta | null> {
  const data = await mondayGraphQL<{
    boards?: Array<{
      id: string | number;
      name: string;
      columns?: MondayColumn[] | null;
    }> | null;
  }>(BOARD_META_QUERY, { boardIds: [boardId] });

  const board = data.boards?.[0];
  if (!board) return null;
  return {
    id: String(board.id),
    name: board.name,
    columns: (board.columns ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
    })),
  };
}

/** Map one Monday item to recipient shape via normalizeUsPhone + firstNameOf. */
function toRecipient(
  item: ItemNode,
  phoneColumnId: string,
  timezoneColumnId?: string | null,
): BoardRecipient {
  const cell = (item.column_values ?? []).find((c) => c.id === phoneColumnId);
  // PhoneValue's raw `phone` when present; `text` is the raw-string fallback
  // for text-type phone columns (or a blank phone cell's empty display text).
  const rawPhone = (cell?.phone ?? cell?.text ?? "").trim();
  const tzCell = timezoneColumnId
    ? (item.column_values ?? []).find((c) => c.id === timezoneColumnId)
    : undefined;
  return {
    mondayItemId: String(item.id),
    name: item.name,
    firstName: firstNameOf(item.name),
    phoneE164: rawPhone
      ? normalizeUsPhone(rawPhone, cell?.country_short_name ?? undefined)
      : null,
    rawPhone,
    rawTimezone: (tzCell?.text ?? "").trim() || null,
  };
}

/**
 * Fetch EVERY item on a board (items_page → next_items_page(cursor) until the
 * cursor comes back null) and map each to recipient shape. Order is Monday's
 * board order, preserved across page boundaries. Returns [] for an unknown
 * board — routes distinguish that via getBoardMeta. `timezoneColumnId` (the
 * list's optional Monday timezone column) adds that column to the fetch and
 * fills `rawTimezone`.
 */
export async function fetchBoardRecipients(
  boardId: string,
  phoneColumnId: string,
  timezoneColumnId?: string | null,
): Promise<BoardRecipient[]> {
  const columnIds = timezoneColumnId
    ? [phoneColumnId, timezoneColumnId]
    : [phoneColumnId];
  const first = await mondayGraphQL<{
    boards?: Array<{ items_page: ItemsPageNode }> | null;
  }>(FIRST_PAGE_QUERY, { boardIds: [boardId], columnIds });

  const firstPage = first.boards?.[0]?.items_page;
  if (!firstPage) return [];

  const recipients: BoardRecipient[] = [];
  for (const item of firstPage.items ?? []) {
    recipients.push(toRecipient(item, phoneColumnId, timezoneColumnId));
  }

  let cursor = firstPage.cursor;
  while (cursor) {
    const next = await mondayGraphQL<{ next_items_page?: ItemsPageNode | null }>(
      NEXT_PAGE_QUERY,
      { cursor, columnIds },
    );
    const page = next.next_items_page;
    for (const item of page?.items ?? []) {
      recipients.push(toRecipient(item, phoneColumnId, timezoneColumnId));
    }
    cursor = page?.cursor ?? null;
  }

  return recipients;
}
