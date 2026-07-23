// @vitest-environment node
// The route calls the verified (jose ES256) auth path; node env avoids the
// jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";

// Mock the server-only repo; the route is the unit under test.
const h = vi.hoisted(() => ({
  retryRecipient: vi.fn(),
  markRecipientFailed: vi.fn(),
  getCampaign: vi.fn(),
}));

vi.mock("@/lib/sms/repo", () => ({
  retryRecipient: h.retryRecipient,
  markRecipientFailed: h.markRecipientFailed,
  getCampaign: h.getCampaign,
}));

import { PATCH } from "./route";

let marketingToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["marketing"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return {
    "x-amzn-oidc-data": marketingToken,
    "content-type": "application/json",
  };
}

const CAMPAIGN_ID = "11111111-2222-3333-4444-555555555555";
const RECIPIENT_ID = "66666666-7777-8888-9999-000000000000";

/** Next 15 route context: params is a Promise. */
function ctx(id: string = CAMPAIGN_ID, recipientId: string = RECIPIENT_ID) {
  return {
    params: Promise.resolve({ id, recipientId }),
  };
}

function patchReq(body: unknown, headers: HeadersInit = marketingHeaders()) {
  return new Request(
    `http://x/api/campaigns/${CAMPAIGN_ID}/recipients/${RECIPIENT_ID}`,
    {
      method: "PATCH",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

describe("PATCH /api/campaigns/[id]/recipients/[recipientId]", () => {
  test("401 when unauthenticated", async () => {
    const res = await PATCH(
      patchReq({ action: "retry" }, { "content-type": "application/json" }),
      ctx(),
    );
    expect(res.status).toBe(401);
    expect(h.retryRecipient).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await PATCH(
      patchReq(
        { action: "retry" },
        {
          "x-amzn-oidc-data": viewersToken,
          "content-type": "application/json",
        },
      ),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(h.retryRecipient).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON", async () => {
    const res = await PATCH(patchReq("{not json"), ctx());
    expect(res.status).toBe(400);
  });

  test("404 (not 500) for a non-UUID recipientId, before any repo call", async () => {
    const res = await PATCH(
      patchReq({ action: "retry" }),
      ctx(CAMPAIGN_ID, "not-a-uuid"),
    );
    expect(res.status).toBe(404);
    expect(h.retryRecipient).not.toHaveBeenCalled();
    expect(h.markRecipientFailed).not.toHaveBeenCalled();
  });

  test("404 (not 500) for a non-UUID campaign id, before any repo call", async () => {
    const res = await PATCH(
      patchReq({ action: "mark_failed" }),
      ctx("not-a-uuid", RECIPIENT_ID),
    );
    expect(res.status).toBe(404);
    expect(h.retryRecipient).not.toHaveBeenCalled();
    expect(h.markRecipientFailed).not.toHaveBeenCalled();
  });

  test("400 + issues on an unknown action", async () => {
    const res = await PATCH(patchReq({ action: "resend" }), ctx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues).toBeDefined();
    expect(h.retryRecipient).not.toHaveBeenCalled();
    expect(h.markRecipientFailed).not.toHaveBeenCalled();
  });

  test("retry → 200 with the recipient + possibly re-opened campaign status", async () => {
    const recipient = {
      id: RECIPIENT_ID,
      campaign_id: CAMPAIGN_ID,
      status: "pending",
    };
    h.retryRecipient.mockResolvedValue(recipient);
    // retryRecipient re-opens completed → sending; the response surfaces it.
    h.getCampaign.mockResolvedValue({ id: CAMPAIGN_ID, status: "sending" });

    const res = await PATCH(patchReq({ action: "retry" }), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.recipient).toEqual(recipient);
    expect(json.campaignStatus).toBe("sending");
    expect(h.retryRecipient).toHaveBeenCalledWith(RECIPIENT_ID);
    expect(h.getCampaign).toHaveBeenCalledWith(CAMPAIGN_ID);
  });

  test("retry → 409 when the recipient is not retryable", async () => {
    h.retryRecipient.mockResolvedValue(null);
    const res = await PATCH(patchReq({ action: "retry" }), ctx());
    expect(res.status).toBe(409);
    expect(h.getCampaign).not.toHaveBeenCalled();
  });

  test("mark_failed → 200 with the recipient, passing the optional note", async () => {
    const recipient = {
      id: RECIPIENT_ID,
      campaign_id: CAMPAIGN_ID,
      status: "failed",
    };
    h.markRecipientFailed.mockResolvedValue(recipient);
    const res = await PATCH(
      patchReq({ action: "mark_failed", note: "checked portal: never sent" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.recipient).toEqual(recipient);
    expect(h.markRecipientFailed).toHaveBeenCalledWith(
      RECIPIENT_ID,
      "checked portal: never sent",
    );
  });

  test("mark_failed without a note passes undefined through", async () => {
    h.markRecipientFailed.mockResolvedValue({ id: RECIPIENT_ID });
    const res = await PATCH(patchReq({ action: "mark_failed" }), ctx());
    expect(res.status).toBe(200);
    expect(h.markRecipientFailed).toHaveBeenCalledWith(RECIPIENT_ID, undefined);
  });

  test("mark_failed → 409 when the recipient is not failed_ambiguous", async () => {
    h.markRecipientFailed.mockResolvedValue(null);
    const res = await PATCH(patchReq({ action: "mark_failed" }), ctx());
    expect(res.status).toBe(409);
  });
});
