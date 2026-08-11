import "server-only";

import { headers } from "next/headers";
import { getUser } from "../auth";
import { isAdmin } from "../authGroups";

/**
 * Connection facts for the Settings page. Deliberately returns NO secret
 * values — only whether a secret is configured, plus the (non-secret) data-API
 * host and region. The service-role key is never read into a rendered value.
 */
export interface ConnectionInfo {
  supabaseUrlHost: string | null;
  serviceRoleKeySet: boolean;
  albArnSet: boolean;
  region: string;
  cognitoLogoutSet: boolean;
  previewAuth: boolean;
}

/**
 * SMS-campaigns configuration facts — presence booleans ONLY, never values.
 * The Monday token and the SimpleTexting webhook token are injected into the
 * WEB task; the SimpleTexting send token (`SIMPLETEXTING_API_TOKEN`) is
 * normally injected into the WORKER task only, so `simpletextingSendTokenSet`
 * is false here even when the worker is fully configured (it only flips true
 * if the env happens to be set on this task, e.g. local dev).
 */
export interface SmsCampaignsInfo {
  mondayTokenSet: boolean;
  simpletextingWebhookTokenSet: boolean;
  simpletextingSendTokenSet: boolean;
}

export function getSmsCampaignsInfo(): SmsCampaignsInfo {
  return {
    mondayTokenSet: Boolean(process.env.MONDAY_API_TOKEN),
    simpletextingWebhookTokenSet: Boolean(
      process.env.SIMPLETEXTING_WEBHOOK_TOKEN,
    ),
    simpletextingSendTokenSet: Boolean(process.env.SIMPLETEXTING_API_TOKEN),
  };
}

/**
 * Active PREVIEW_AUTH persona for the Settings preview chip. `null` when the
 * shim is off (real ALB auth — the persona cookie is never consulted). On,
 * it resolves the EFFECTIVE shim identity through `getUser` (same group parse
 * + `mh-preview-persona=member` demote as auth.ts) and labels it by
 * admin-group membership — so the chip can never disagree with the gates.
 */
export async function getPreviewPersona(): Promise<"admin" | "member" | null> {
  if (!process.env.PREVIEW_AUTH) return null;
  const user = await getUser(await headers());
  return user !== null && isAdmin(user) ? "admin" : "member";
}

export function getConnectionInfo(): ConnectionInfo {
  let host: string | null = null;
  const url = process.env.SUPABASE_URL;
  if (url) {
    try {
      host = new URL(url).host;
    } catch {
      host = "(unparseable)";
    }
  }
  return {
    supabaseUrlHost: host,
    serviceRoleKeySet: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    albArnSet: Boolean(process.env.ALB_ARN),
    region: process.env.ALB_REGION || process.env.AWS_REGION || "us-east-1",
    cognitoLogoutSet: Boolean(process.env.COGNITO_LOGOUT_URL),
    previewAuth: Boolean(process.env.PREVIEW_AUTH),
  };
}
