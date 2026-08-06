import { z } from "zod";

// Pure module — imported by client components and the API routes alike.
// Nothing server-only or node-only may be imported here.

/** The two recipient-source kinds. Mirrors the DB `source` check constraint. */
export const LIST_SOURCES = ["csv", "monday"] as const;
export type ListSource = (typeof LIST_SOURCES)[number];

/**
 * Board input: a raw numeric board id, or a pasted Monday board URL
 * (`https://<acct>.monday.com/boards/<id>[/views/...]`) from which the id is
 * extracted. Anything else is rejected. Shared with the board-preview API.
 */
export const MondayBoardInputSchema = z
  .string()
  .trim()
  .min(1, "board is required")
  .transform((value) => {
    const fromUrl = value.match(/boards\/(\d+)/);
    return fromUrl ? fromUrl[1] : value;
  })
  .refine((value) => /^\d+$/.test(value), {
    message: "board must be a numeric board id or a Monday board URL",
  });

/** Validated input for creating a CSV contact list (file text travels raw). */
export const CsvListInputSchema = z.object({
  source: z.literal("csv"),
  name: z.string().trim().min(1, "name is required"),
  filename: z.string().trim().min(1, "filename is required"),
  content: z.string().min(1, "content is required"),
});

/** Validated input for linking a Monday board as a contact list. */
export const MondayListInputSchema = z.object({
  source: z.literal("monday"),
  name: z.string().trim().min(1, "name is required"),
  board: MondayBoardInputSchema,
  phoneColumnId: z.string().trim().min(1, "phoneColumnId is required"),
});

export const ListCreateInputSchema = z.discriminatedUnion("source", [
  CsvListInputSchema,
  MondayListInputSchema,
]);
export type ListCreateInput = z.infer<typeof ListCreateInputSchema>;

/** A row of `marketinghub.contact_lists`. */
export interface ContactList {
  id: string;
  name: string;
  source: ListSource;
  storage_path: string | null;
  original_filename: string | null;
  monday_board_id: string | null;
  monday_board_name: string | null;
  monday_phone_column_id: string | null;
  /** ok / invalid / duplicate member counts (csv lists; monday lists stay 0). */
  contact_count: number;
  invalid_count: number;
  duplicate_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** A row of `marketinghub.contact_list_members` (csv lists only). */
export interface ContactListMember {
  id: string;
  list_id: string;
  name: string;
  first_name: string;
  phone_e164: string | null;
  raw_phone: string;
  reason: "ok" | "invalid" | "duplicate";
  /** Consent provenance, verbatim from the uploaded sheet (audit evidence). */
  consent_source: string | null;
  consent_date: string | null;
  created_at: string;
}
