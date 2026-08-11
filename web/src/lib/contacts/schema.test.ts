import { describe, expect, test } from "vitest";
import { MondayListInputSchema } from "./schema";

const validInput = {
  source: "monday",
  name: "Wellness board",
  board: "4567890123",
  phoneColumnId: "phone_col",
};

describe("MondayListInputSchema", () => {
  test("accepts a valid input without the optional column ids", () => {
    const parsed = MondayListInputSchema.parse(validInput);
    expect(parsed.board).toBe("4567890123");
    expect(parsed.mondayTimezoneColumnId).toBeUndefined();
    expect(parsed.mondayOutcomeColumnId).toBeUndefined();
  });

  test("extracts the board id from a pasted Monday board URL", () => {
    const parsed = MondayListInputSchema.parse({
      ...validInput,
      board: "https://acct.monday.com/boards/4567890123/views/1",
    });
    expect(parsed.board).toBe("4567890123");
  });

  test("accepts optional timezone + outcome column ids (trimmed)", () => {
    const parsed = MondayListInputSchema.parse({
      ...validInput,
      mondayTimezoneColumnId: " tz_col ",
      mondayOutcomeColumnId: "outcome_col",
    });
    expect(parsed.mondayTimezoneColumnId).toBe("tz_col");
    expect(parsed.mondayOutcomeColumnId).toBe("outcome_col");
  });

  test("rejects blank optional column ids (omit them instead)", () => {
    for (const key of ["mondayTimezoneColumnId", "mondayOutcomeColumnId"]) {
      const res = MondayListInputSchema.safeParse({
        ...validInput,
        [key]: "   ",
      });
      expect(res.success, key).toBe(false);
    }
  });

  test("rejects a missing phoneColumnId", () => {
    const res = MondayListInputSchema.safeParse({
      ...validInput,
      phoneColumnId: "",
    });
    expect(res.success).toBe(false);
  });
});
