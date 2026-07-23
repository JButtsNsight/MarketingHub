import { timingSafeEqual } from "node:crypto";

import { normalizeUsPhone } from "@/lib/sms/phone";
import {
  applyDeliveryReport,
  findRecipientForDeliveryReport,
  recordSuppression,
  recordWebhookEvent,
  suppressActiveRecipientsByPhone,
  type WebhookKind,
} from "@/lib/sms/repo";

/**
 * SimpleTexting webhook receiver (delivery reports + unsubscribes).
 *
 * NOT gated on ALB identity — SimpleTexting's sender is not a Cognito user.
 * Auth is the `?token=` shared secret against SIMPLETEXTING_WEBHOOK_TOKEN,
 * compared with a length-guarded constant-time equality; 401 happens BEFORE
 * anything touches storage.
 *
 * Payload shapes are undocumented (verified 2026-07-22), so classification is
 * a tolerant heuristic over the JSON (including nested `values`/`data`
 * objects) and EVERY authorized request is audited raw into
 * `sms_webhook_events` — those rows are the evidence for tuning. Authorized
 * requests always get 200 {ok:true}: SimpleTexting must never retry-loop us,
 * and the delivery-report lane doubles as the `failed_ambiguous`
 * auto-reconciliation path.
 */

export const dynamic = "force-dynamic";

/** Constant-time shared-secret check; false on unset env or length mismatch. */
function isAuthorized(req: Request): boolean {
  const expected = process.env.SIMPLETEXTING_WEBHOOK_TOKEN;
  if (!expected) return false;
  const provided = new URL(req.url).searchParams.get("token");
  if (!provided) return false;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths — guard first. Length is the
  // only thing this early-return leaks.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** The payload plus its nested `values`/`data` objects, when present. */
function candidateObjects(payload: unknown): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  const push = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      candidates.push(value as Record<string, unknown>);
    }
  };
  push(payload);
  if (candidates.length > 0) {
    push(candidates[0].values);
    push(candidates[0].data);
  }
  return candidates;
}

/** First string value among `keys` across the candidate objects. */
function firstString(
  candidates: Array<Record<string, unknown>>,
  keys: string[],
): string | null {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

const PHONE_KEYS = [
  "contactPhone",
  "phone",
  "phoneNumber",
  "phone_number",
  "number",
  "to",
  "from",
];

const MESSAGE_ID_KEYS = ["messageId", "message_id", "smsId", "sms_id", "id"];

const STATUS_KEYS = ["status", "deliveryStatus", "delivery_status", "state"];

/** Event-type-ish fields checked for /unsub/i. */
const TYPE_KEYS = ["type", "eventType", "event_type", "event"];

/** Raw phone from the payload, normalized to E.164 (null when unusable). */
function extractPhone(
  candidates: Array<Record<string, unknown>>,
): string | null {
  const raw = firstString(candidates, PHONE_KEYS);
  return raw ? normalizeUsPhone(raw) : null;
}

/** Message id may arrive as a string or a number — stringify numbers. */
function extractMessageId(
  candidates: Array<Record<string, unknown>>,
): string | null {
  for (const candidate of candidates) {
    for (const key of MESSAGE_ID_KEYS) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
  }
  return null;
}

type Classification =
  | { kind: "unsubscribe"; phone: string | null }
  | {
      kind: "delivery_report";
      stMessageId: string;
      delivered: boolean;
      status: string;
      phone: string | null;
    }
  | { kind: "unknown" };

/**
 * Tolerant classifier. Unsubscribe-ish wins first (an /unsub/i event type or
 * `action: 'STOP'`); then delivery-ish (a message id AND a status matching
 * /deliver/i, with /undeliver|fail/i checked first — "UNDELIVERED" contains
 * "deliver"); everything else is `unknown`.
 */
function classify(payload: unknown): Classification {
  const candidates = candidateObjects(payload);
  if (candidates.length === 0) return { kind: "unknown" };

  for (const candidate of candidates) {
    for (const key of TYPE_KEYS) {
      const value = candidate[key];
      if (typeof value === "string" && /unsub/i.test(value)) {
        return { kind: "unsubscribe", phone: extractPhone(candidates) };
      }
    }
    const action = candidate.action;
    if (typeof action === "string" && action.trim().toUpperCase() === "STOP") {
      return { kind: "unsubscribe", phone: extractPhone(candidates) };
    }
  }

  const stMessageId = extractMessageId(candidates);
  const status = firstString(candidates, STATUS_KEYS);
  if (stMessageId && status) {
    if (/undeliver|fail/i.test(status)) {
      return {
        kind: "delivery_report",
        stMessageId,
        delivered: false,
        status,
        phone: extractPhone(candidates),
      };
    }
    if (/deliver/i.test(status)) {
      return {
        kind: "delivery_report",
        stMessageId,
        delivered: true,
        status,
        phone: extractPhone(candidates),
      };
    }
  }

  return { kind: "unknown" };
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawText = await req.text();
  let payload: unknown = null;
  let raw: unknown;
  try {
    payload = JSON.parse(rawText);
    raw = payload;
  } catch {
    raw = { unparsed: rawText };
  }

  let kind: WebhookKind = "unknown";
  let matchedRecipientId: string | null = null;
  try {
    const classified = classify(payload);
    kind = classified.kind;

    if (classified.kind === "unsubscribe" && classified.phone) {
      // STOP is permanent: record it, then sweep every not-yet-attempted
      // outbox row for the phone across all campaigns.
      await recordSuppression(classified.phone, "stop", raw);
      await suppressActiveRecipientsByPhone(classified.phone);
    }

    if (classified.kind === "delivery_report") {
      const recipient = await findRecipientForDeliveryReport({
        stMessageId: classified.stMessageId,
        phone: classified.phone,
      });
      if (recipient) {
        // Also the failed_ambiguous auto-reconciliation lane: a report
        // proves the ambiguous POST landed (or terminally did not deliver).
        await applyDeliveryReport(recipient.id, {
          delivered: classified.delivered,
          stMessageId: classified.stMessageId,
          detail: classified.delivered
            ? undefined
            : `delivery report: ${classified.status}`,
        });
        matchedRecipientId = recipient.id;
      }
    }
  } catch (err) {
    // Never bounce an authorized webhook — the raw audit row below (and the
    // stored events generally) are how failures get diagnosed.
    console.error("[sms] webhook processing failed:", err);
  }

  try {
    await recordWebhookEvent(kind, raw, matchedRecipientId);
  } catch (err) {
    console.error("[sms] webhook audit insert failed:", err);
  }

  return Response.json({ ok: true });
}
