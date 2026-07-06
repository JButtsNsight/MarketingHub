import { describe, expect, test } from "vitest";
import { TemplateInputSchema } from "./schema";

const validText = {
  name: "Spring Promo",
  type: "text",
  category: "Promotion",
  body: "Big spring sale — up to 40% off.",
};

const validEmail = {
  name: "Welcome Email",
  type: "email",
  category: "Onboarding",
  subject: "Welcome aboard!",
  body: "<h1>Welcome</h1>",
};

describe("TemplateInputSchema", () => {
  test("accepts a valid text template", () => {
    const parsed = TemplateInputSchema.parse(validText);
    expect(parsed.name).toBe("Spring Promo");
    expect(parsed.type).toBe("text");
    expect(parsed.tags).toEqual([]);
  });

  test("accepts a valid email template", () => {
    const parsed = TemplateInputSchema.parse(validEmail);
    expect(parsed.subject).toBe("Welcome aboard!");
  });

  test("rejects an empty name", () => {
    const res = TemplateInputSchema.safeParse({ ...validText, name: "   " });
    expect(res.success).toBe(false);
  });

  test("rejects an invalid type", () => {
    const res = TemplateInputSchema.safeParse({ ...validText, type: "sms" });
    expect(res.success).toBe(false);
  });

  test("rejects an empty category", () => {
    const res = TemplateInputSchema.safeParse({ ...validText, category: "" });
    expect(res.success).toBe(false);
  });

  test("rejects an email template with no subject", () => {
    const { subject, ...noSubject } = validEmail;
    const res = TemplateInputSchema.safeParse(noSubject);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toMatch(/subject/i);
    }
  });

  test("rejects an email template with a blank subject", () => {
    const res = TemplateInputSchema.safeParse({ ...validEmail, subject: "  " });
    expect(res.success).toBe(false);
  });

  test("rejects an empty body", () => {
    const res = TemplateInputSchema.safeParse({ ...validText, body: "" });
    expect(res.success).toBe(false);
  });

  test("normalizes tags: lowercased, trimmed, de-duplicated, blanks dropped", () => {
    const parsed = TemplateInputSchema.parse({
      ...validText,
      tags: ["  Sale ", "SALE", "spring", "sale", "", "   "],
    });
    expect(parsed.tags).toEqual(["sale", "spring"]);
  });

  test("defaults tags to an empty array when omitted", () => {
    const parsed = TemplateInputSchema.parse(validText);
    expect(parsed.tags).toEqual([]);
  });
});
