// @vitest-environment node
// Shared-secret (query token) auth, not ALB identity — SimpleTexting's
// webhook sender never passes through Cognito. Node env for node:crypto.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the server-only repo; the route is the unit under test.
const h = vi.hoisted(() => ({
  recordSuppression: vi.fn(),
  suppressActiveRecipientsByPhone: vi.fn(),
  recordWebhookEvent: vi.fn(),
  findRecipientForDeliveryReport: vi.fn(),
  applyDeliveryReport: vi.fn(),
}));

vi.mock("@/lib/sms/repo", () => ({
  recordSuppression: h.recordSuppression,
  suppressActiveRecipientsByPhone: h.suppressActiveRecipientsByPhone,
  recordWebhookEvent: h.recordWebhookEvent,
  findRecipientForDeliveryReport: h.findRecipientForDeliveryReport,
  applyDeliveryReport: h.applyDeliveryReport,
}));

import { POST } from "./route";

const TOKEN = "shh-webhook-secret";

beforeEach(() => {
  process.env.SIMPLETEXTING_WEBHOOK_TOKEN = TOKEN;
  for (const fn of Object.values(h)) fn.mockReset();
  h.recordSuppression.mockResolvedValue(undefined);
  h.suppressActiveRecipientsByPhone.mockResolvedValue(0);
  h.recordWebhookEvent.mockResolvedValue("evt-1");
  h.findRecipientForDeliveryReport.mockResolvedValue(null);
  h.applyDeliveryReport.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.SIMPLETEXTING_WEBHOOK_TOKEN;
});

function postReq(body: unknown, token: string | null = TOKEN) {
  const qs = token === null ? "" : `?token=${encodeURIComponent(token)}`;
  return new Request(`http://x/api/webhooks/simpletexting${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function expectNoStorage() {
  expect(h.recordWebhookEvent).not.toHaveBeenCalled();
  expect(h.recordSuppression).not.toHaveBeenCalled();
  expect(h.suppressActiveRecipientsByPhone).not.toHaveBeenCalled();
  expect(h.applyDeliveryReport).not.toHaveBeenCalled();
}

describe("POST /api/webhooks/simpletexting — auth", () => {
  test("401 before any storage when the env token is unset", async () => {
    delete process.env.SIMPLETEXTING_WEBHOOK_TOKEN;
    const res = await POST(postReq({ type: "UNSUBSCRIBE" }));
    expect(res.status).toBe(401);
    expectNoStorage();
  });

  test("401 before any storage when the query token is missing", async () => {
    const res = await POST(postReq({ type: "UNSUBSCRIBE" }, null));
    expect(res.status).toBe(401);
    expectNoStorage();
  });

  test("401 on a wrong token of the same length", async () => {
    const res = await POST(
      postReq({ type: "UNSUBSCRIBE" }, "shh-webhook-secreT"),
    );
    expect(res.status).toBe(401);
    expectNoStorage();
  });

  test("401 on a wrong-length token (length-guarded timingSafeEqual)", async () => {
    const res = await POST(postReq({ type: "UNSUBSCRIBE" }, "short"));
    expect(res.status).toBe(401);
    expectNoStorage();
  });

  test("uses ALB-independent shared-secret auth (source contract)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./route.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("@/lib/auth");
    expect(source).toContain("timingSafeEqual");
  });
});

describe("POST /api/webhooks/simpletexting — unsubscribe", () => {
  test("records the STOP and fans it out across active recipients", async () => {
    const payload = { type: "UNSUBSCRIBE", phone: "+15550000001" };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(h.recordSuppression).toHaveBeenCalledWith(
      "+15550000001",
      "stop",
      payload,
    );
    expect(h.suppressActiveRecipientsByPhone).toHaveBeenCalledWith(
      "+15550000001",
    );
    expect(h.recordWebhookEvent).toHaveBeenCalledWith(
      "unsubscribe",
      payload,
      null,
    );
  });

  test("classifies a nested values object with action STOP, normalizing the phone", async () => {
    const payload = {
      event: "incoming-message",
      values: { action: "STOP", from: "(555) 000-0002" },
    };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(h.recordSuppression).toHaveBeenCalledWith(
      "+15550000002",
      "stop",
      payload,
    );
    expect(h.suppressActiveRecipientsByPhone).toHaveBeenCalledWith(
      "+15550000002",
    );
    expect(h.recordWebhookEvent).toHaveBeenCalledWith(
      "unsubscribe",
      payload,
      null,
    );
  });

  test("still audits an unsubscribe whose phone cannot be normalized", async () => {
    const payload = { eventType: "contact_unsubscribed", phone: "123" };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(h.recordSuppression).not.toHaveBeenCalled();
    expect(h.suppressActiveRecipientsByPhone).not.toHaveBeenCalled();
    expect(h.recordWebhookEvent).toHaveBeenCalledWith(
      "unsubscribe",
      payload,
      null,
    );
  });
});

describe("POST /api/webhooks/simpletexting — delivery reports", () => {
  test("delivered: reconciles the matched recipient", async () => {
    h.findRecipientForDeliveryReport.mockResolvedValue({
      id: "r1",
      st_message_id: null,
    });
    const payload = {
      messageId: "st-msg-1",
      status: "DELIVERED",
      contactPhone: "+15550000001",
    };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);

    expect(h.findRecipientForDeliveryReport).toHaveBeenCalledWith({
      stMessageId: "st-msg-1",
      phone: "+15550000001",
    });
    expect(h.applyDeliveryReport).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({
        delivered: true,
        stMessageId: "st-msg-1",
        // the row's known id travels along so the repo never overwrites a
        // DIFFERENT already-learned st_message_id
        currentStMessageId: null,
      }),
    );
    expect(h.recordWebhookEvent).toHaveBeenCalledWith(
      "delivery_report",
      payload,
      "r1",
    );
  });

  test("passes the matched row's known st_message_id through as currentStMessageId", async () => {
    h.findRecipientForDeliveryReport.mockResolvedValue({
      id: "r9",
      st_message_id: "st-msg-9",
    });
    const payload = { messageId: "st-msg-9", status: "DELIVERED" };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(h.applyDeliveryReport).toHaveBeenCalledWith(
      "r9",
      expect.objectContaining({ currentStMessageId: "st-msg-9" }),
    );
  });

  test("undelivered beats the /deliver/i match and settles as not delivered", async () => {
    h.findRecipientForDeliveryReport.mockResolvedValue({ id: "r2" });
    const payload = { messageId: "st-msg-2", status: "UNDELIVERED" };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(h.applyDeliveryReport).toHaveBeenCalledWith(
      "r2",
      expect.objectContaining({ delivered: false }),
    );
  });

  test("failure-ish status nested under data, with a numeric message id", async () => {
    h.findRecipientForDeliveryReport.mockResolvedValue({ id: "r3" });
    const payload = { data: { id: 77, status: "message send failed" } };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(h.findRecipientForDeliveryReport).toHaveBeenCalledWith({
      stMessageId: "77",
      phone: null,
    });
    expect(h.applyDeliveryReport).toHaveBeenCalledWith(
      "r3",
      expect.objectContaining({ delivered: false, stMessageId: "77" }),
    );
  });

  test("audits a delivery report that matches no recipient", async () => {
    const payload = { messageId: "st-unknown", status: "delivered" };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(h.applyDeliveryReport).not.toHaveBeenCalled();
    expect(h.recordWebhookEvent).toHaveBeenCalledWith(
      "delivery_report",
      payload,
      null,
    );
  });
});

describe("POST /api/webhooks/simpletexting — unknown + malformed", () => {
  test("audits an unrecognized payload as kind unknown", async () => {
    const payload = { hello: "world" };
    const res = await POST(postReq(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.recordSuppression).not.toHaveBeenCalled();
    expect(h.applyDeliveryReport).not.toHaveBeenCalled();
    expect(h.recordWebhookEvent).toHaveBeenCalledWith(
      "unknown",
      payload,
      null,
    );
  });

  test("wraps malformed JSON as {unparsed} and still returns 200", async () => {
    const res = await POST(postReq("this is not json{"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.recordWebhookEvent).toHaveBeenCalledWith(
      "unknown",
      { unparsed: "this is not json{" },
      null,
    );
  });

  test("returns 200 even when the audit insert itself fails", async () => {
    h.recordWebhookEvent.mockRejectedValue(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(postReq({ hello: "world" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    errorSpy.mockRestore();
  });
});
