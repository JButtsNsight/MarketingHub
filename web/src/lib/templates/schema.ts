import { z } from "zod";

/** The two campaign template kinds. Mirrors the DB `type` check constraint. */
export const TEMPLATE_TYPES = ["text", "email"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

/**
 * Fixed starter category list surfaced in the upload UI (Phase 4). The DB
 * column is a plain `text` (no enum) so this stays a soft, extensible list.
 */
export const TEMPLATE_CATEGORIES = [
  "Newsletter",
  "Promotion",
  "Onboarding",
  "Transactional",
  "Announcement",
  "Other",
] as const;

/** Tags: trimmed + lowercased + de-duplicated, blanks dropped. */
const tagsSchema = z
  .array(z.string())
  .default([])
  .transform((tags) => {
    const normalized = tags
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    return Array.from(new Set(normalized));
  });

/**
 * Validated input for creating a template. `subject` is required only for
 * email templates (enforced via superRefine so the error path points at
 * `subject`).
 */
export const TemplateInputSchema = z
  .object({
    name: z.string().trim().min(1, "name is required"),
    type: z.enum(TEMPLATE_TYPES, {
      errorMap: () => ({ message: "type must be 'text' or 'email'" }),
    }),
    category: z.string().trim().min(1, "category is required"),
    tags: tagsSchema,
    subject: z.string().trim().optional(),
    body: z.string().min(1, "body is required"),
  })
  .superRefine((val, ctx) => {
    if (val.type === "email" && (!val.subject || val.subject.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject"],
        message: "subject is required for email templates",
      });
    }
  });

/** Validated create-input (post-transform: tags normalized). */
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

/** A full template row as stored in `marketinghub.templates`. */
export interface Template {
  id: string;
  name: string;
  type: TemplateType;
  category: string;
  tags: string[];
  subject: string | null;
  body: string;
  storage_path: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
