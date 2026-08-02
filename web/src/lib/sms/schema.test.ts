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
  contactListId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sendDate: "2026-07-30",
  sendTime: "10:30",
  sendTimezone: "America/Los_Angeles",
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
  test("accepts a valid input", () => {
    const parsed = CampaignCreateInputSchema.parse(validInput);
    expect(parsed.name).toBe("July Recall");
    expect(parsed.contactListId).toBe("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(parsed.sendDate).toBe("2026-07-30");
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

  test("rejects a non-UUID contactListId", () => {
    for (const contactListId of ["list-1", "1234567890", "", undefined]) {
      const res = CampaignCreateInputSchema.safeParse({
        ...validInput,
        contactListId,
      });
      expect(res.success, `contactListId ${JSON.stringify(contactListId)}`).toBe(
        false,
      );
    }
  });

  test("rejects a sendDate that is not YYYY-MM-DD", () => {
    for (const sendDate of ["2026-7-5", "07/30/2026", "2026-07-30T00:00:00Z", ""]) {
      const res = CampaignCreateInputSchema.safeParse({ ...validInput, sendDate });
      expect(res.success, `sendDate ${JSON.stringify(sendDate)}`).toBe(false);
    }
  });

  test("rejects weekend sendDates (blasts are Mon–Fri)", () => {
    // 2026-08-01 is a Saturday, 2026-08-02 a Sunday, 2026-08-03 a Monday.
    for (const [sendDate, ok] of [
      ["2026-08-01", false],
      ["2026-08-02", false],
      ["2026-08-03", true],
    ] as const) {
      const res = CampaignCreateInputSchema.safeParse({ ...validInput, sendDate });
      expect(res.success, `sendDate ${sendDate}`).toBe(ok);
    }
  });

  test("rejects a sendTime outside the 30-minute 08:00–13:00 slot grid", () => {
    for (const sendTime of ["07:30", "13:30", "09:15", "8:00", ""]) {
      const res = CampaignCreateInputSchema.safeParse({ ...validInput, sendTime });
      expect(res.success, `sendTime ${JSON.stringify(sendTime)}`).toBe(false);
    }
  });

  test("accepts Hawaii as a send zone", () => {
    const res = CampaignCreateInputSchema.safeParse({
      ...validInput,
      sendTimezone: "Pacific/Honolulu",
    });
    expect(res.success).toBe(true);
  });

  test("rejects a sendTimezone outside the US send zones", () => {
    for (const sendTimezone of ["America/Anchorage", "UTC", "Eastern", ""]) {
      const res = CampaignCreateInputSchema.safeParse({ ...validInput, sendTimezone });
      expect(res.success, `sendTimezone ${JSON.stringify(sendTimezone)}`).toBe(false);
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
      contact_list_id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      monday_board_id: "1234567890",
      monday_phone_column_id: "phone",
      message_body: "Hi {{firstName}}, time for your visit.",
      send_date: "2026-07-30",
      send_time: "10:30",
      send_timezone: "America/Los_Angeles",
      send_at: "2026-07-30T15:30:00.000Z",
      status: "scheduled",
      created_by: "user@example.com",
      created_at: "2026-07-22T12:00:00.000Z",
      updated_at: "2026-07-22T12:00:00.000Z",
    };

    // A sheet-sourced campaign has no Monday coordinates at all.
    const csvCampaign: SmsCampaign = {
      ...campaign,
      id: "c0000000-0000-0000-0000-000000000002",
      monday_board_id: null,
      monday_phone_column_id: null,
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
    expect(csvCampaign.monday_board_id).toBeNull();
    expect(recipient.phone_e164).toBe("+15551230000");
    expect(counts.count).toBe(42);
  });
});
