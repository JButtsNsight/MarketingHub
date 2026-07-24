import { describe, expect, test } from "vitest";
import {
  CAMPAIGN_STATUSES,
  CampaignCreateInputSchema,
  RECIPIENT_STATUSES,
  type CampaignCounts,
  type SmsCampaign,
  type SmsCampaignRecipient,
} from "./schema";

const validInput = {
  name: "July Recall",
  templateId: "5f0c4e0a-9b1d-4f6e-8b3a-2c7d9e1f0a2b",
  mondayBoardId: "1234567890",
  mondayPhoneColumnId: "phone",
  sendDate: "2026-07-30",
};

describe("status constants", () => {
  test("CAMPAIGN_STATUSES matches the campaign state machine", () => {
    expect(CAMPAIGN_STATUSES).toEqual([
      "scheduled",
      "sending",
      "paused",
      "completed",
      "canceled",
    ]);
  });

  test("RECIPIENT_STATUSES matches the recipient state machine", () => {
    expect(RECIPIENT_STATUSES).toEqual([
      "pending",
      "claimed",
      "sending",
      "sent",
      "delivered",
      "undelivered",
      "failed",
      "failed_ambiguous",
      "suppressed",
      "skipped",
      "canceled",
    ]);
  });
});

describe("CampaignCreateInputSchema", () => {
  test("accepts a valid input with a raw board id", () => {
    const parsed = CampaignCreateInputSchema.parse(validInput);
    expect(parsed.name).toBe("July Recall");
    expect(parsed.mondayBoardId).toBe("1234567890");
    expect(parsed.sendDate).toBe("2026-07-30");
  });

  test("extracts the board id from a pasted Monday board URL", () => {
    const parsed = CampaignCreateInputSchema.parse({
      ...validInput,
      mondayBoardId: "https://acme.monday.com/boards/9876543210",
    });
    expect(parsed.mondayBoardId).toBe("9876543210");
  });

  test("extracts the board id from a Monday URL with a view suffix", () => {
    const parsed = CampaignCreateInputSchema.parse({
      ...validInput,
      mondayBoardId: "https://acme.monday.com/boards/424242/views/555",
    });
    expect(parsed.mondayBoardId).toBe("424242");
  });

  test("trims surrounding whitespace on the board id", () => {
    const parsed = CampaignCreateInputSchema.parse({
      ...validInput,
      mondayBoardId: "  1234567890  ",
    });
    expect(parsed.mondayBoardId).toBe("1234567890");
  });

  test("rejects a board value that is neither an id nor a board URL", () => {
    const res = CampaignCreateInputSchema.safeParse({
      ...validInput,
      mondayBoardId: "not-a-board",
    });
    expect(res.success).toBe(false);
  });

  test("rejects an empty board id", () => {
    const res = CampaignCreateInputSchema.safeParse({
      ...validInput,
      mondayBoardId: "   ",
    });
    expect(res.success).toBe(false);
  });

  test("rejects an empty name", () => {
    const res = CampaignCreateInputSchema.safeParse({
      ...validInput,
      name: "   ",
    });
    expect(res.success).toBe(false);
  });

  test("rejects a non-UUID templateId", () => {
    const res = CampaignCreateInputSchema.safeParse({
      ...validInput,
      templateId: "template-1",
    });
    expect(res.success).toBe(false);
  });

  test("rejects an empty mondayPhoneColumnId", () => {
    const res = CampaignCreateInputSchema.safeParse({
      ...validInput,
      mondayPhoneColumnId: "",
    });
    expect(res.success).toBe(false);
  });

  test("rejects a sendDate that is not YYYY-MM-DD", () => {
    for (const sendDate of ["2026-7-5", "07/30/2026", "2026-07-30T00:00:00Z", ""]) {
      const res = CampaignCreateInputSchema.safeParse({ ...validInput, sendDate });
      expect(res.success, `sendDate ${JSON.stringify(sendDate)}`).toBe(false);
    }
  });

  test("rejects a sendDate that is not a real calendar date", () => {
    for (const sendDate of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      const res = CampaignCreateInputSchema.safeParse({ ...validInput, sendDate });
      expect(res.success, `sendDate ${JSON.stringify(sendDate)}`).toBe(false);
    }
  });
});

describe("row interfaces (compile-time contract with the DDL)", () => {
  test("SmsCampaign / SmsCampaignRecipient / CampaignCounts use the DDL's snake_case fields", () => {
    const campaign: SmsCampaign = {
      id: "c0000000-0000-0000-0000-000000000001",
      name: "July Recall",
      template_id: "5f0c4e0a-9b1d-4f6e-8b3a-2c7d9e1f0a2b",
      monday_board_id: "1234567890",
      monday_phone_column_id: "phone",
      message_body: "Hi {{firstName}}, time for your visit.",
      send_date: "2026-07-30",
      send_at: "2026-07-30T15:30:00.000Z",
      status: "scheduled",
      created_by: "user@example.com",
      created_at: "2026-07-22T12:00:00.000Z",
      updated_at: "2026-07-22T12:00:00.000Z",
    };

    const recipient: SmsCampaignRecipient = {
      id: "r0000000-0000-0000-0000-000000000001",
      campaign_id: campaign.id,
      monday_item_id: "111",
      name: "Jane Doe",
      first_name: "Jane",
      phone_e164: "+15551230000",
      rendered_text: "Hi Jane, time for your visit.",
      status: "pending",
      attempts: 0,
      send_after: "2026-07-30T15:30:00.000Z",
      claimed_at: null,
      claim_expires_at: null,
      st_message_id: null,
      st_credits: null,
      last_error: null,
      created_at: "2026-07-22T12:00:00.000Z",
      updated_at: "2026-07-22T12:00:00.000Z",
    };

    const counts: CampaignCounts = {
      campaign_id: campaign.id,
      status: "pending",
      count: 42,
    };

    expect(campaign.status).toBe("scheduled");
    expect(recipient.phone_e164).toBe("+15551230000");
    expect(counts.count).toBe(42);
  });
});
